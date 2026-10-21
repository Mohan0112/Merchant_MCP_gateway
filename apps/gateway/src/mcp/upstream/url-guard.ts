import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';

/**
 * Server-side request forgery protection for admin-entered upstream URLs (threat model, Task 22).
 * An upstream may only be a public address, unless its host name is on the platform's allow-list
 * of in-cluster MCP servers (woo-mcp, fx-mcp, hosted and per-store servers). Everything else that
 * is private, loopback, link-local (cloud metadata at 169.254.169.254), CGNAT, multicast or
 * reserved is refused, whatever name points at it.
 *
 * The check runs twice: when an admin saves or tests a URL (a clear error in the form), and on
 * every connection the gateway opens (the `lookup` below), so a name that later starts resolving
 * to an internal address (DNS rebinding) is refused at connect time too.
 */

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private (also the k3s pod and Service ranges)
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
  ['2001:db8::', 32], // documentation
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6');
}

/** IPv4-mapped IPv6 (::ffff:10.0.0.1) is checked as the IPv4 address it carries. */
function isBlockedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return BLOCKED.check(mapped[1]!, 'ipv4');
  const family = isIP(address);
  if (family === 0) return true;
  return BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export class UpstreamUrlBlocked extends Error {
  override name = 'UpstreamUrlBlocked';
  readonly code = 'ESSRFBLOCKED';
}

type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) =>
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses),
    ),
  );

/** "woo-mcp", "*.ahjin-mcp-hosted.svc.cluster.local", "woo-mcp.store-*.svc.cluster.local". */
function hostPattern(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .toLowerCase()
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[a-z0-9-]*');
  return new RegExp(`^${escaped}$`);
}

export class UpstreamUrlGuard {
  private readonly allowed: RegExp[];

  constructor(
    /** Host names (with * for one label part) that may resolve to cluster-internal addresses. */
    allowedPrivateHosts: string[],
    private readonly resolve: Resolver = systemResolver,
  ) {
    this.allowed = allowedPrivateHosts.filter(Boolean).map(hostPattern);
  }

  /** Throws UpstreamUrlBlocked with a reason an admin can act on, or resolves when the URL is fine. */
  async check(rawUrl: string): Promise<void> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new UpstreamUrlBlocked('That is not a valid URL.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new UpstreamUrlBlocked('Only http:// and https:// URLs can be registered.');
    }
    if (url.username || url.password) {
      throw new UpstreamUrlBlocked(
        'Put credentials in the credential field, not in the URL, so they are stored encrypted.',
      );
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (this.isPlatformHost(host)) return;
    const addresses = isIP(host)
      ? [host]
      : await this.resolve(host).then(
          (found) => found.map((a) => a.address),
          () => {
            throw new UpstreamUrlBlocked(`The host name ${host} could not be resolved.`);
          },
        );
    const blocked = addresses.find(isBlockedAddress);
    if (blocked) {
      throw new UpstreamUrlBlocked(
        `${isIP(host) ? host : `${host} resolves to ${blocked}, which`} is a private, loopback or link-local address. ` +
          'Only public servers and the platform’s own MCP servers can be registered.',
      );
    }
  }

  isPlatformHost(host: string): boolean {
    return this.allowed.some((pattern) => pattern.test(host));
  }

  /**
   * A drop-in for dns.lookup, for the HTTP client the gateway uses to reach upstreams: resolves
   * normally, then refuses the connection if a non-platform host resolved to a blocked address.
   */
  readonly lookup = (
    hostname: string,
    options: { all?: boolean; family?: number | string },
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    dnsLookup(hostname, { ...options, all: true, verbatim: true } as never, (error, found) => {
      if (error) return callback(error, '');
      const addresses = found as unknown as LookupAddress[];
      if (!this.isPlatformHost(hostname.toLowerCase())) {
        const blocked = addresses.find((a) => isBlockedAddress(a.address));
        if (blocked) {
          return callback(
            new UpstreamUrlBlocked(
              `${hostname} resolved to ${blocked.address}, which upstream connections may not reach`,
            ),
            '',
          );
        }
      }
      if (options.all) return callback(null, addresses);
      const first = addresses[0]!;
      callback(null, first.address, first.family);
    });
  };
}
