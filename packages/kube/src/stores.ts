/**
 * The Store custom resource (stores.ahjin.dev, Task 30). The dashboard creates one per store a user
 * asks for; the store-operator provisions it and reports progress in its status. The resource's
 * name is the store's slug, and everything derived from it is predictable:
 *
 *   Store "acme"  →  namespace store-acme  →  Helm release store-acme  →  upstream slug store-acme
 *                    →  storefront acme.<domain>  →  tools store-acme__list_orders, …
 */
export const STORE_GROUP = 'ahjin.dev';
export const STORE_VERSION = 'v1alpha1';
export const STORE_FINALIZER = 'ahjin.dev/teardown';

/** 2-14 characters, so the derived upstream slug (store-<slug>) fits the gateway's 20. */
export const STORE_SLUG = /^[a-z][a-z0-9-]{1,13}$/;

export type StorePhase = 'Provisioning' | 'Ready' | 'Failed' | 'Deleting';

export interface StoreSpec {
  displayName: string;
  ownerId: string;
  ownerEmail: string;
  /** Bumped by "Retry" on a failed store; a new value restarts provisioning. */
  retry?: number;
}

export interface StoreStatus {
  phase?: StorePhase;
  /** The step in progress or the one that failed, e.g. "helm", "registration". */
  step?: string;
  /** Machine-readable cause of a failure: ProvisioningTimeout, HelmFailed, … */
  reason?: string;
  message?: string;
  url?: string;
  namespace?: string;
  upstreamSlug?: string;
  startedAt?: string;
  readyAt?: string;
  /** The spec.retry the status describes; a newer one means "start over". */
  observedRetry?: number;
}

export interface StoreResource {
  apiVersion: string;
  kind: 'Store';
  metadata: {
    name: string;
    namespace: string;
    uid?: string;
    resourceVersion?: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    finalizers?: string[];
    labels?: Record<string, string>;
  };
  spec: StoreSpec;
  status?: StoreStatus;
}

export const storesPath = (namespace: string) =>
  `/apis/${STORE_GROUP}/${STORE_VERSION}/namespaces/${namespace}/stores`;
export const storePath = (namespace: string, name: string) => `${storesPath(namespace)}/${name}`;

export const storeNamespace = (slug: string) => `store-${slug}`;
export const storeRelease = (slug: string) => `store-${slug}`;
export const storeUpstreamSlug = (slug: string) => `store-${slug}`;
