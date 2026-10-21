import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { classifyError } from './errors';
import { createSdkClientFactory } from './sdk-client';
import { UpstreamUrlBlocked, UpstreamUrlGuard } from './url-guard';

/** A resolver that answers from a table, like DNS would. */
const table = (entries: Record<string, string[]>) => async (host: string) => {
  const addresses = entries[host];
  if (!addresses) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

const guard = new UpstreamUrlGuard(
  ['woo-mcp', 'fx-mcp', 'woo-mcp.store-*.svc.cluster.local'],
  table({
    'api.example.com': ['93.184.216.34'],
    'postgres.ahjin.svc': ['10.43.12.7'],
    'woo-mcp': ['10.43.0.21'],
    'woo-mcp.store-acme.svc.cluster.local': ['10.43.1.9'],
    'rebind.example.com': ['93.184.216.34', '127.0.0.1'],
    'metadata.example.com': ['169.254.169.254'],
  }),
);

describe('UpstreamUrlGuard.check', () => {
  it.each([
    'https://api.example.com/mcp',
    'http://woo-mcp:8080/mcp',
    'http://woo-mcp.store-acme.svc.cluster.local:8080/mcp',
  ])('allows %s', async (url) => {
    await expect(guard.check(url)).resolves.toBeUndefined();
  });

  it.each([
    ['http://169.254.169.254/latest/meta-data/', /169\.254\.169\.254/],
    ['http://metadata.example.com/', /resolves to 169\.254\.169\.254/],
    ['http://postgres.ahjin.svc:5432/', /resolves to 10\.43\.12\.7/],
    ['http://rebind.example.com/mcp', /resolves to 127\.0\.0\.1/],
    ['http://[::1]:8080/', /::1/],
    ['http://[::ffff:127.0.0.1]/', /::ffff/],
    ['http://0.0.0.0:8080/', /0\.0\.0\.0/],
    ['http://unknown.example.com/', /could not be resolved/],
    ['file:///etc/passwd', /Only http/],
    ['https://user:secret@api.example.com/mcp', /credential field/],
  ])('refuses %s', async (url, reason) => {
    await expect(guard.check(url)).rejects.toThrow(reason);
    await expect(guard.check(url)).rejects.toBeInstanceOf(UpstreamUrlBlocked);
  });

  it('matches wildcards within one label only', () => {
    expect(guard.isPlatformHost('woo-mcp.store-acme.svc.cluster.local')).toBe(true);
    expect(guard.isPlatformHost('woo-mcp.store-a.b.svc.cluster.local')).toBe(false);
    expect(guard.isPlatformHost('postgres')).toBe(false);
  });
});

describe('connect-time check', () => {
  it('refuses to open a connection to a host that resolves to loopback', async () => {
    const server: Server = createServer((_req, res) => res.end('{}'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    try {
      // "localhost" passed no registration check here, as if DNS changed after it was saved.
      const factory = createSdkClientFactory(new UpstreamUrlGuard([]));
      const client = factory({ url: `http://localhost:${port}/mcp`, headers: {} }, () => {});
      const failure = await client.connect(2000).catch((error: unknown) => classifyError(error));
      expect(failure).toMatchObject({ reason: 'BLOCKED' });
      await client.close();
    } finally {
      server.close();
    }
  });
});
