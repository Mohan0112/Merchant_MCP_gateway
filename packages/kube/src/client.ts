import { readFileSync } from 'node:fs';
import { Agent, fetch } from 'undici';

/** How to reach the Kubernetes API: the in-cluster service account, or anything a test provides. */
export interface KubeConfig {
  server: string;
  /** Read on every request: projected service-account tokens are rotated by the kubelet. */
  token: () => string;
  ca?: string;
}

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

/** The pod's own service account (automountServiceAccountToken must be on). */
export function inClusterConfig(): KubeConfig {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
  if (!host) throw new Error('not running in a Kubernetes pod (KUBERNETES_SERVICE_HOST unset)');
  return {
    server: `https://${host.includes(':') ? `[${host}]` : host}:${port}`,
    token: () => readFileSync(`${SA_DIR}/token`, 'utf8').trim(),
    ca: readFileSync(`${SA_DIR}/ca.crt`, 'utf8'),
  };
}

/** A failed API call, with the HTTP status and Kubernetes' reason (NotFound, AlreadyExists, …). */
export class KubeError extends Error {
  override name = 'KubeError';
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

export const isNotFound = (error: unknown) => error instanceof KubeError && error.status === 404;
export const isConflict = (error: unknown) => error instanceof KubeError && error.status === 409;

type Patch = 'merge' | 'json';
const PATCH_TYPES: Record<Patch, string> = {
  merge: 'application/merge-patch+json',
  json: 'application/json-patch+json',
};

/**
 * The handful of verbs the platform needs, over plain HTTPS. Paths are API paths
 * ("/api/v1/namespaces/x/secrets/y", "/apis/ahjin.dev/v1alpha1/namespaces/ahjin/stores"): explicit,
 * and easy to match against the RBAC rules that allow them.
 */
export class KubeClient {
  private readonly dispatcher: Agent;

  constructor(
    private readonly config: KubeConfig,
    private readonly timeoutMs = 15_000,
  ) {
    this.dispatcher = new Agent({ connect: config.ca ? { ca: config.ca } : {} });
  }

  async request<T>(method: string, path: string, body?: unknown, patch?: Patch): Promise<T> {
    const response = await fetch(`${this.config.server}${path}`, {
      method,
      dispatcher: this.dispatcher,
      headers: {
        Authorization: `Bearer ${this.config.token()}`,
        Accept: 'application/json',
        ...(body !== undefined
          ? { 'Content-Type': patch ? PATCH_TYPES[patch] : 'application/json' }
          : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      throw new KubeError(
        response.status,
        String(json.reason ?? response.statusText),
        String(json.message ?? `${method} ${path}: HTTP ${response.status}`),
      );
    }
    return json as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  /** The object, or null when it doesn't exist. */
  async find<T>(path: string): Promise<T | null> {
    try {
      return await this.get<T>(path);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  create<T>(collectionPath: string, object: unknown): Promise<T> {
    return this.request<T>('POST', collectionPath, object);
  }

  patch<T>(path: string, patch: unknown, type: Patch = 'merge'): Promise<T> {
    return this.request<T>('PATCH', path, patch, type);
  }

  /** Deletes the object; already gone counts as done. */
  async delete(path: string, propagation: 'Background' | 'Foreground' = 'Background') {
    try {
      await this.request('DELETE', path, {
        kind: 'DeleteOptions',
        apiVersion: 'v1',
        propagationPolicy: propagation,
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}
