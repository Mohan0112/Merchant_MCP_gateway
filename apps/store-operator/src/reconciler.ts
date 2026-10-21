import {
  STORE_FINALIZER,
  storeNamespace,
  storeRelease,
  storeUpstreamSlug,
  type StoreResource,
  type StoreStatus,
} from '@ahjin/kube';
import type { Logger } from '@ahjin/logger';
import type { BaseValues } from './config';
import type { GatewayPort } from './gateway';
import type { HelmPort } from './helm';

/** Reading and updating Store resources (the Kubernetes API in production, memory in tests). */
export interface StoreApi {
  list(): Promise<StoreResource[]>;
  patchStatus(name: string, status: StoreStatus): Promise<void>;
  setFinalizers(name: string, finalizers: string[]): Promise<void>;
}

/** The namespace and Secrets of one store. */
export interface ResourcesPort {
  ensureNamespace(namespace: string, slug: string): Promise<void>;
  ensureSecrets(namespace: string, ownerEmail: string): Promise<string>;
  deleteNamespace(namespace: string): Promise<void>;
  namespaceGone(namespace: string): Promise<boolean>;
}

export interface ReconcilerDeps {
  stores: StoreApi;
  resources: ResourcesPort;
  helm: HelmPort;
  gateway: GatewayPort;
  logger: Logger;
  baseValues: BaseValues;
  chartPath: string;
  provisionTimeoutMs: number;
  maxParallel: number;
  now?: () => Date;
}

/** A failure that retrying won't fix: the store goes to Failed with this reason. */
class ProvisioningFailed extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

function merge(base: unknown, extra: unknown): unknown {
  if (!base || typeof base !== 'object' || Array.isArray(base)) return extra;
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(extra as Record<string, unknown>)) {
    result[key] = key in result ? merge(result[key], value) : value;
  }
  return result;
}

/**
 * Level-based reconciliation of Store resources (Task 30). Every pass looks at what each store's
 * status says and what exists, and does the next idempotent step, so a retried request, a crash or
 * an operator restart in the middle of provisioning simply continues from where things stand:
 *
 *   (new) ─▶ Provisioning: namespace → Secrets → Helm release (--wait) → gateway registration ─▶ Ready
 *                 │ timeout or Helm failure                                  ▲
 *                 ▼                                                          │ spec.retry bumped
 *               Failed ──────────────────────────────────────────────────────┘
 *   deletionTimestamp (any phase) ─▶ Deleting: unregister → helm uninstall → delete namespace → finalizer off
 */
export class StoreReconciler {
  private readonly inFlight = new Set<string>();
  private readonly now: () => Date;

  constructor(private readonly deps: ReconcilerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** One pass: starts work for every store that needs it, at most maxParallel provisionings at once. */
  async tick(): Promise<void> {
    const stores = await this.deps.stores.list();
    for (const store of stores) {
      const name = store.metadata.name;
      if (this.inFlight.has(name) || !this.needsWork(store)) continue;
      // Deletions never wait for a slot: freeing resources is what lets the others proceed.
      if (!store.metadata.deletionTimestamp && this.provisioning() >= this.deps.maxParallel)
        continue;
      this.inFlight.add(name);
      void this.reconcile(store)
        .catch((error: unknown) =>
          this.deps.logger.error({ err: error, store: name }, 'reconcile failed; will retry'),
        )
        .finally(() => this.inFlight.delete(name));
    }
  }

  /** Stores being worked on right now (for tests and the readiness endpoint). */
  busy(): string[] {
    return [...this.inFlight];
  }

  private provisioning(): number {
    return this.inFlight.size;
  }

  needsWork(store: StoreResource): boolean {
    if (store.metadata.deletionTimestamp) return true;
    const status = store.status;
    if (!status?.phase || (status.observedRetry ?? 0) !== (store.spec.retry ?? 0)) return true;
    return status.phase === 'Provisioning';
  }

  async reconcile(store: StoreResource): Promise<void> {
    if (store.metadata.deletionTimestamp) return this.teardown(store);
    return this.provision(store);
  }

  private async provision(store: StoreResource): Promise<void> {
    const slug = store.metadata.name;
    const namespace = storeNamespace(slug);
    const release = storeRelease(slug);
    const upstreamSlug = storeUpstreamSlug(slug);
    const retry = store.spec.retry ?? 0;
    const log = this.deps.logger.child({ store: slug });
    const { stores } = this.deps;

    if (!(store.metadata.finalizers ?? []).includes(STORE_FINALIZER)) {
      await stores.setFinalizers(slug, [...(store.metadata.finalizers ?? []), STORE_FINALIZER]);
    }

    // A new store, or a retry, starts the clock; a resumed one keeps its original start time.
    const resuming =
      store.status?.phase === 'Provisioning' && (store.status.observedRetry ?? 0) === retry;
    const startedAt =
      resuming && store.status?.startedAt ? new Date(store.status.startedAt) : this.now();
    if (!resuming) {
      log.info({ retry }, 'provisioning store');
      await stores.patchStatus(slug, {
        phase: 'Provisioning',
        step: 'namespace',
        reason: '',
        message: 'Creating the namespace',
        namespace,
        startedAt: startedAt.toISOString(),
        observedRetry: retry,
      });
    } else {
      log.info({ step: store.status?.step }, 'resuming provisioning');
    }

    const remainingMs = () =>
      this.deps.provisionTimeoutMs - (this.now().getTime() - startedAt.getTime());
    const step = async (name: string, message: string) => {
      if (remainingMs() <= 0) {
        throw new ProvisioningFailed(
          'ProvisioningTimeout',
          `Not ready within ${Math.round(this.deps.provisionTimeoutMs / 60_000)} minutes (stopped at: ${name}).`,
        );
      }
      await stores.patchStatus(slug, { step: name, message });
    };

    try {
      await step('namespace', 'Creating the namespace');
      await this.deps.resources.ensureNamespace(namespace, slug);

      await step('secrets', 'Creating database, WordPress and MCP credentials');
      const mcpToken = await this.deps.resources.ensureSecrets(namespace, store.spec.ownerEmail);

      await step('helm', 'Installing WordPress, MariaDB and the store MCP server');
      const existing = await this.deps.helm.status(release, namespace);
      if (existing && existing.status !== 'deployed') {
        // An install interrupted by a crash or a timeout: nothing in it is worth keeping yet.
        log.warn({ status: existing.status }, 'unfinished Helm release; installing it again');
        await this.deps.helm.uninstall(release, namespace);
      }
      const { global } = this.deps.baseValues;
      const host = `${slug}.${global.domain}`;
      const url = `${global.scheme}://${host}/`;
      const values = merge(this.deps.baseValues, {
        store: { settings: { name: store.spec.displayName }, ingress: { host } },
        'woo-mcp': { env: { STORE_PUBLIC_URL: `${global.scheme}://${host}` } },
      });
      try {
        await this.deps.helm.upgradeInstall(
          release,
          namespace,
          this.deps.chartPath,
          values,
          Math.floor(remainingMs() / 1000),
        );
      } catch (error) {
        throw new ProvisioningFailed('HelmFailed', (error as Error).message);
      }

      await step('registration', 'Registering the store MCP server in the gateway');
      await this.deps.gateway.register({
        slug: upstreamSlug,
        displayName: `Store: ${store.spec.displayName}`,
        url: `http://woo-mcp.${namespace}.svc.cluster.local:8080/mcp`,
        credential: mcpToken,
        store: slug,
      });

      await stores.patchStatus(slug, {
        phase: 'Ready',
        step: '',
        reason: '',
        message: 'Ready',
        url,
        upstreamSlug,
        readyAt: this.now().toISOString(),
      });
      log.info(
        { url, seconds: Math.round((this.now().getTime() - startedAt.getTime()) / 1000) },
        'store ready',
      );
    } catch (error) {
      if (error instanceof ProvisioningFailed) {
        log.warn({ reason: error.reason, detail: error.message }, 'store provisioning failed');
        await stores.patchStatus(slug, {
          phase: 'Failed',
          reason: error.reason,
          message: error.message,
        });
        return;
      }
      // Anything else (API conflict, gateway restarting) is retried on the next pass.
      throw error;
    }
  }

  private async teardown(store: StoreResource): Promise<void> {
    const slug = store.metadata.name;
    const namespace = storeNamespace(slug);
    const log = this.deps.logger.child({ store: slug });
    if (!(store.metadata.finalizers ?? []).includes(STORE_FINALIZER)) return;

    if (store.status?.phase !== 'Deleting') {
      log.info('tearing down store');
      await this.deps.stores.patchStatus(slug, {
        phase: 'Deleting',
        step: 'registration',
        message: 'Removing the MCP server from the gateway',
      });
    }
    // Tools first, so no client can call into a store that's going away.
    await this.deps.gateway.unregister(storeUpstreamSlug(slug));
    if (!(await this.deps.resources.namespaceGone(namespace))) {
      await this.deps.stores.patchStatus(slug, { step: 'helm', message: 'Uninstalling the store' });
      await this.deps.helm.uninstall(storeRelease(slug), namespace);
      await this.deps.stores.patchStatus(slug, {
        step: 'namespace',
        message: 'Deleting the namespace, its volumes and Secrets',
      });
      await this.deps.resources.deleteNamespace(namespace);
      // Namespace deletion finishes asynchronously; the next pass checks again.
      if (!(await this.deps.resources.namespaceGone(namespace))) return;
    }
    await this.deps.stores.setFinalizers(
      slug,
      (store.metadata.finalizers ?? []).filter((f) => f !== STORE_FINALIZER),
    );
    log.info('store removed');
  }
}
