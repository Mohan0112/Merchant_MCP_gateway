/** What the reconciler needs from the gateway; tests substitute a fake. */
export interface GatewayPort {
  /** Creates or updates the store's MCP server registration (idempotent). */
  register(upstream: {
    slug: string;
    displayName: string;
    url: string;
    credential: string;
    store: string;
  }): Promise<void>;
  /** Removes it; an unknown slug counts as done. */
  unregister(slug: string): Promise<void>;
}

/**
 * The gateway's internal API (/internal/upstreams), reachable only inside the cluster: the Ingress
 * doesn't route /internal, and the gateway's NetworkPolicy admits this operator by label. A shared
 * token from Secret gateway-internal authenticates the operator.
 */
export class GatewayClient implements GatewayPort {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  }

  async register(upstream: Parameters<GatewayPort['register']>[0]): Promise<void> {
    const res = await this.call('PUT', `/internal/upstreams/${upstream.slug}`, upstream);
    if (!res.ok) {
      throw new Error(
        `gateway refused the registration: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`,
      );
    }
  }

  async unregister(slug: string): Promise<void> {
    const res = await this.call('DELETE', `/internal/upstreams/${slug}`);
    if (!res.ok && res.status !== 404) {
      throw new Error(`gateway refused to unregister ${slug}: HTTP ${res.status}`);
    }
  }
}
