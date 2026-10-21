import { isConflict, type KubeClient } from '@ahjin/kube';
import { randomBytes } from 'node:crypto';

const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const SALTS = [
  'auth-key',
  'secure-auth-key',
  'logged-in-key',
  'nonce-key',
  'auth-salt',
  'secure-auth-salt',
  'logged-in-salt',
  'nonce-salt',
];

interface SecretDef {
  name: string;
  generate: (ownerEmail: string) => Record<string, string>;
}

/** The Secrets the store chart references by name (as scripts/secrets.mjs makes for the main store). */
const STORE_SECRETS: SecretDef[] = [
  { name: 'store-db', generate: () => ({ 'root-password': token(18), password: token(18) }) },
  {
    name: 'store-wp',
    generate: (ownerEmail) => ({
      ...Object.fromEntries(SALTS.map((key) => [key, token(48)])),
      'admin-user': 'storeadmin',
      'admin-email': ownerEmail,
      'admin-password': token(18),
    }),
  },
  {
    name: 'store-woo-api',
    generate: () => ({ 'consumer-key': `ck_${hex(20)}`, 'consumer-secret': `cs_${hex(20)}` }),
  },
  { name: 'woo-mcp-auth', generate: () => ({ token: token(32) }) },
];

interface SecretObject {
  data?: Record<string, string>;
}

/**
 * The per-store namespace and its Secrets. Every method is idempotent: it creates what's missing
 * and leaves what exists alone, so a retried or resumed provisioning never rotates a password
 * under a running database.
 */
export class StoreResources {
  constructor(private readonly kube: KubeClient) {}

  async ensureNamespace(namespace: string, slug: string): Promise<void> {
    const labels = {
      'app.kubernetes.io/part-of': 'ahjin',
      'app.kubernetes.io/managed-by': 'store-operator',
      'ahjin.dev/store': slug,
      // The same admission rules as the platform's own namespace.
      'pod-security.kubernetes.io/enforce': 'restricted',
      'pod-security.kubernetes.io/enforce-version': 'latest',
    };
    const existing = await this.kube.find<{ status?: { phase?: string } }>(
      `/api/v1/namespaces/${namespace}`,
    );
    if (existing?.status?.phase === 'Terminating') {
      throw new Error(`namespace ${namespace} is still being deleted; try again in a moment`);
    }
    if (existing) return;
    try {
      await this.kube.create('/api/v1/namespaces', {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: namespace, labels },
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }

  /** Creates missing Secrets; returns the woo-mcp bearer token the gateway will use. */
  async ensureSecrets(namespace: string, ownerEmail: string): Promise<string> {
    for (const def of STORE_SECRETS) {
      const path = `/api/v1/namespaces/${namespace}/secrets/${def.name}`;
      if (await this.kube.find(path)) continue;
      try {
        await this.kube.create(`/api/v1/namespaces/${namespace}/secrets`, {
          apiVersion: 'v1',
          kind: 'Secret',
          type: 'Opaque',
          metadata: {
            name: def.name,
            labels: {
              'app.kubernetes.io/part-of': 'ahjin',
              'app.kubernetes.io/managed-by': 'store-operator',
            },
          },
          stringData: def.generate(ownerEmail),
        });
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
    const auth = await this.kube.get<SecretObject>(
      `/api/v1/namespaces/${namespace}/secrets/woo-mcp-auth`,
    );
    const encoded = auth.data?.token;
    if (!encoded) throw new Error(`Secret woo-mcp-auth in ${namespace} has no token`);
    return Buffer.from(encoded, 'base64').toString('utf8');
  }

  /** Whether the namespace is gone (deletion is asynchronous and takes a while). */
  async namespaceGone(namespace: string): Promise<boolean> {
    return (await this.kube.find(`/api/v1/namespaces/${namespace}`)) === null;
  }

  async deleteNamespace(namespace: string): Promise<void> {
    await this.kube.delete(`/api/v1/namespaces/${namespace}`, 'Foreground');
  }
}
