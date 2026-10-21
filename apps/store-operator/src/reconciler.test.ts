import { STORE_FINALIZER, type StoreResource, type StoreStatus } from '@ahjin/kube';
import { createLogger } from '@ahjin/logger';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { GatewayPort } from './gateway';
import type { HelmPort, ReleaseStatus } from './helm';
import { StoreReconciler, type ResourcesPort, type StoreApi } from './reconciler';

const quiet = createLogger('test', {
  destination: new Writable({ write: (_c, _e, done) => done() }),
});

class FakeStores implements StoreApi {
  readonly items = new Map<string, StoreResource>();
  add(name: string, extra: Partial<StoreResource> = {}) {
    this.items.set(name, {
      apiVersion: 'ahjin.dev/v1alpha1',
      kind: 'Store',
      metadata: { name, namespace: 'ahjin', finalizers: [] },
      spec: { displayName: name.toUpperCase(), ownerId: 'u1', ownerEmail: 'owner@example.com' },
      ...extra,
    });
  }
  get(name: string) {
    return this.items.get(name)!;
  }
  async list() {
    return [...this.items.values()].map((s) => structuredClone(s));
  }
  async patchStatus(name: string, status: StoreStatus) {
    const store = this.items.get(name)!;
    store.status = { ...store.status, ...status };
  }
  async setFinalizers(name: string, finalizers: string[]) {
    const store = this.items.get(name)!;
    store.metadata.finalizers = finalizers;
    // Like the API server: a deleted object goes away once its finalizers are gone.
    if (store.metadata.deletionTimestamp && finalizers.length === 0) this.items.delete(name);
  }
}

class FakeResources implements ResourcesPort {
  readonly namespaces = new Set<string>();
  readonly terminating = new Map<string, number>();
  async ensureNamespace(namespace: string) {
    this.namespaces.add(namespace);
  }
  async ensureSecrets(namespace: string) {
    return `token-${namespace}`;
  }
  async deleteNamespace(namespace: string) {
    if (!this.terminating.has(namespace)) this.terminating.set(namespace, 1);
  }
  async namespaceGone(namespace: string) {
    const left = this.terminating.get(namespace);
    if (left === undefined) return !this.namespaces.has(namespace);
    if (left > 0) {
      this.terminating.set(namespace, left - 1);
      return false;
    }
    this.namespaces.delete(namespace);
    return true;
  }
}

class FakeHelm implements HelmPort {
  readonly releases = new Map<string, ReleaseStatus>();
  readonly calls: string[] = [];
  readonly values = new Map<string, unknown>();
  failWith: string | null = null;
  hold: Promise<void> | null = null;
  async status(release: string) {
    return this.releases.get(release) ?? null;
  }
  async upgradeInstall(release: string, _ns: string, _chart: string, values: unknown) {
    this.calls.push(`install ${release}`);
    if (this.hold) await this.hold;
    if (this.failWith) throw new Error(this.failWith);
    this.values.set(release, values);
    this.releases.set(release, { status: 'deployed', revision: 1 });
  }
  async uninstall(release: string) {
    this.calls.push(`uninstall ${release}`);
    this.releases.delete(release);
  }
}

class FakeGateway implements GatewayPort {
  readonly registered = new Map<string, Parameters<GatewayPort['register']>[0]>();
  async register(upstream: Parameters<GatewayPort['register']>[0]) {
    this.registered.set(upstream.slug, upstream);
  }
  async unregister(slug: string) {
    this.registered.delete(slug);
  }
}

function setup(clock = { now: new Date('2026-10-22T10:00:00Z') }, maxParallel = 3) {
  const stores = new FakeStores();
  const resources = new FakeResources();
  const helm = new FakeHelm();
  const gateway = new FakeGateway();
  const reconciler = new StoreReconciler({
    stores,
    resources,
    helm,
    gateway,
    logger: quiet,
    baseValues: {
      global: { domain: 'example.test', scheme: 'http' },
      store: { backup: { enabled: false } },
    },
    chartPath: '/charts/store-instance',
    provisionTimeoutMs: 15 * 60_000,
    maxParallel,
    now: () => clock.now,
  });
  return { stores, resources, helm, gateway, reconciler, clock };
}

describe('StoreReconciler', () => {
  it('provisions a new store: namespace, Secrets, Helm release, gateway registration', async () => {
    const { stores, resources, helm, gateway, reconciler } = setup();
    stores.add('acme');
    await reconciler.reconcile(stores.get('acme'));

    expect(stores.get('acme').metadata.finalizers).toEqual([STORE_FINALIZER]);
    expect(stores.get('acme').status).toMatchObject({
      phase: 'Ready',
      url: 'http://acme.example.test/',
      namespace: 'store-acme',
      upstreamSlug: 'store-acme',
      observedRetry: 0,
    });
    expect(resources.namespaces.has('store-acme')).toBe(true);
    expect(helm.values.get('store-acme')).toMatchObject({
      global: { domain: 'example.test' },
      store: {
        backup: { enabled: false },
        settings: { name: 'ACME' },
        ingress: { host: 'acme.example.test' },
      },
      'woo-mcp': { env: { STORE_PUBLIC_URL: 'http://acme.example.test' } },
    });
    expect(gateway.registered.get('store-acme')).toEqual({
      slug: 'store-acme',
      displayName: 'Store: ACME',
      url: 'http://woo-mcp.store-acme.svc.cluster.local:8080/mcp',
      credential: 'token-store-acme',
      store: 'acme',
    });
    expect(reconciler.needsWork(stores.get('acme'))).toBe(false);
  });

  it('resumes after a restart mid-install: starts the unfinished release over, keeps the start time', async () => {
    const { stores, helm, reconciler } = setup();
    stores.add('acme', {
      status: {
        phase: 'Provisioning',
        step: 'helm',
        startedAt: '2026-10-22T09:58:00.000Z',
        observedRetry: 0,
      },
    });
    helm.releases.set('store-acme', { status: 'pending-install', revision: 1 });
    expect(reconciler.needsWork(stores.get('acme'))).toBe(true);

    await reconciler.reconcile(stores.get('acme'));
    expect(helm.calls).toEqual(['uninstall store-acme', 'install store-acme']);
    expect(stores.get('acme').status).toMatchObject({
      phase: 'Ready',
      startedAt: '2026-10-22T09:58:00.000Z',
    });
  });

  it('fails cleanly with a reason after the provisioning timeout, and starts over on retry', async () => {
    const { stores, helm, reconciler, clock } = setup();
    stores.add('acme', {
      metadata: { name: 'acme', namespace: 'ahjin', finalizers: [STORE_FINALIZER] },
      status: {
        phase: 'Provisioning',
        step: 'helm',
        startedAt: '2026-10-22T09:40:00.000Z',
        observedRetry: 0,
      },
    });
    await reconciler.reconcile(stores.get('acme'));
    expect(stores.get('acme').status).toMatchObject({
      phase: 'Failed',
      reason: 'ProvisioningTimeout',
      message: 'Not ready within 15 minutes (stopped at: namespace).',
    });
    expect(helm.calls).toEqual([]);
    expect(reconciler.needsWork(stores.get('acme'))).toBe(false);

    // "Retry" in the dashboard bumps spec.retry: a fresh attempt with a fresh clock.
    stores.get('acme').spec.retry = 1;
    expect(reconciler.needsWork(stores.get('acme'))).toBe(true);
    clock.now = new Date('2026-10-22T10:05:00Z');
    await reconciler.reconcile(stores.get('acme'));
    expect(stores.get('acme').status).toMatchObject({
      phase: 'Ready',
      observedRetry: 1,
      startedAt: '2026-10-22T10:05:00.000Z',
    });
  });

  it('reports a Helm failure with its message', async () => {
    const { stores, helm, gateway, reconciler } = setup();
    helm.failWith = 'helm upgrade failed: timed out waiting for the condition';
    stores.add('acme');
    await reconciler.reconcile(stores.get('acme'));
    expect(stores.get('acme').status).toMatchObject({
      phase: 'Failed',
      reason: 'HelmFailed',
      message: 'helm upgrade failed: timed out waiting for the condition',
    });
    expect(gateway.registered.size).toBe(0);
  });

  it('tears down in order and removes the finalizer only once the namespace is gone', async () => {
    const { stores, resources, helm, gateway, reconciler } = setup();
    stores.add('acme');
    await reconciler.reconcile(stores.get('acme'));
    stores.get('acme').metadata.deletionTimestamp = '2026-10-22T11:00:00Z';

    await reconciler.reconcile(stores.get('acme'));
    expect(gateway.registered.has('store-acme')).toBe(false);
    expect(helm.calls.at(-1)).toBe('uninstall store-acme');
    expect(resources.terminating.has('store-acme')).toBe(true);
    // The namespace is still terminating: the store stays, marked Deleting.
    expect(stores.get('acme').status?.phase).toBe('Deleting');
    expect(stores.get('acme').metadata.finalizers).toEqual([STORE_FINALIZER]);

    await reconciler.reconcile(stores.get('acme'));
    expect(stores.items.has('acme')).toBe(false);
  });

  it('provisions several stores at once, up to maxParallel', async () => {
    const { stores, helm, reconciler } = setup(undefined, 2);
    let release!: () => void;
    helm.hold = new Promise((resolve) => (release = resolve));
    stores.add('one');
    stores.add('two');
    stores.add('three');
    await reconciler.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reconciler.busy().sort()).toEqual(['one', 'two']);
    expect(helm.calls).toEqual(['install store-one', 'install store-two']);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await reconciler.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stores.get('three').status?.phase).toBe('Ready');
  });
});
