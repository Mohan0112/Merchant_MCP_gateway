import { KubeClient, type StoreResource } from '@ahjin/kube';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, databaseUrl, eventually, type Harness } from '../../test/harness';
import { createTeam, startUpstream, type Team, type TestUpstream } from '../../test/upstreams';

/** Just enough of the Kubernetes API for Store resources in namespace "ahjin". */
const stores = new Map<string, StoreResource>();
const deleted: string[] = [];
let api: Server;
let apiUrl: string;

beforeAll(async () => {
  api = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const base = '/apis/ahjin.dev/v1alpha1/namespaces/ahjin/stores';
      const name = req.url!.startsWith(`${base}/`) ? req.url!.slice(base.length + 1) : null;
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.method === 'GET' && req.url === base)
        return send(200, { items: [...stores.values()] });
      if (req.method === 'POST' && req.url === base) {
        const store = JSON.parse(body) as StoreResource;
        if (stores.has(store.metadata.name))
          return send(409, { reason: 'AlreadyExists', message: 'exists' });
        store.metadata = {
          ...store.metadata,
          namespace: 'ahjin',
          creationTimestamp: new Date().toISOString(),
        };
        stores.set(store.metadata.name, store);
        return send(201, store);
      }
      const store = name ? stores.get(name) : undefined;
      if (!store) return send(404, { reason: 'NotFound', message: 'not found' });
      if (req.method === 'GET') return send(200, store);
      if (req.method === 'DELETE') {
        deleted.push(store.metadata.name);
        return send(200, {});
      }
      if (req.method === 'PATCH') {
        const patch = JSON.parse(body) as { spec?: Record<string, unknown> };
        store.spec = { ...store.spec, ...patch.spec };
        return send(200, store);
      }
      send(405, {});
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve) => api.close(() => resolve())));

let h: Harness;
let team: Team;
let upstream: TestUpstream | undefined;
afterEach(async () => {
  stores.clear();
  deleted.length = 0;
  await h.close();
  await upstream?.close().catch(() => {});
});

const INTERNAL_TOKEN = 'x'.repeat(40);

async function setUp(maxPerUser = 2) {
  h = await createHarness({
    stores: {
      kube: new KubeClient({ server: apiUrl, token: () => 'gateway-sa' }),
      namespace: 'ahjin',
      maxPerUser,
    },
    internalToken: INTERNAL_TOKEN,
  });
  team = await createTeam(h);
}

describe.skipIf(!databaseUrl)('stores', () => {
  it('lets a member request a store, within the limit, and see only their own', async () => {
    await setUp(1);
    const created = await team.member.request('POST', '/api/stores', {
      name: 'Acme Laptops',
      slug: 'acme',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().store).toMatchObject({
      slug: 'acme',
      name: 'Acme Laptops',
      phase: 'Provisioning',
      upstreamSlug: 'store-acme',
    });
    expect(stores.get('acme')).toMatchObject({
      kind: 'Store',
      metadata: { labels: { 'ahjin.dev/owner': team.memberId } },
      spec: { displayName: 'Acme Laptops', ownerId: team.memberId, ownerEmail: 'bob@ahjin.test' },
    });

    // The limit per user, and slug rules.
    const second = await team.member.request('POST', '/api/stores', { name: 'Beta', slug: 'beta' });
    expect(second.statusCode).toBe(409);
    expect(second.json().detail).toMatch(/the limit is 1/);
    expect(
      (await team.admin.request('POST', '/api/stores', { name: 'Bad', slug: 'Bad_Slug' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await team.admin.request('POST', '/api/stores', { name: 'Dup', slug: 'acme' })).statusCode,
    ).toBe(409);

    // An admin's store is invisible to the member; the admin sees both.
    await team.admin.request('POST', '/api/stores', { name: 'HQ', slug: 'hq' });
    expect(
      (await team.member.request('GET', '/api/stores'))
        .json()
        .stores.map((s: { slug: string }) => s.slug),
    ).toEqual(['acme']);
    expect((await team.admin.request('GET', '/api/stores')).json().stores).toHaveLength(2);
    expect((await team.member.request('DELETE', '/api/stores/hq')).statusCode).toBe(404);

    // Retry only applies to a failed store; deletion hands over to the operator.
    expect((await team.member.request('POST', '/api/stores/acme/retry')).statusCode).toBe(409);
    stores.get('acme')!.status = { phase: 'Failed', reason: 'HelmFailed', message: 'boom' };
    const retried = await team.member.request('POST', '/api/stores/acme/retry');
    expect(retried.statusCode).toBe(200);
    expect(stores.get('acme')!.spec.retry).toBe(1);
    expect((await team.member.request('DELETE', '/api/stores/acme')).statusCode).toBe(202);
    expect(deleted).toEqual(['acme']);
  });

  it('registers and removes a store MCP server through the internal API only', async () => {
    await setUp();
    upstream = await startUpstream('acme', { type: 'bearer', token: 'acme-token-0123456789' });
    const put = (token?: string) =>
      h.app.inject({
        method: 'PUT',
        url: '/internal/upstreams/store-acme',
        headers: token ? { authorization: `Bearer ${token}` } : {},
        payload: {
          displayName: 'Store: Acme',
          url: upstream!.url,
          credential: 'acme-token-0123456789',
          store: 'acme',
        },
      });
    expect((await put()).statusCode).toBe(401);
    expect((await put('wrong-token-wrong-token-wrong-token-wrong')).statusCode).toBe(401);
    expect((await put(INTERNAL_TOKEN)).statusCode).toBe(200);
    expect((await put(INTERNAL_TOKEN)).statusCode).toBe(200); // idempotent

    const server = await eventually(async () => {
      const { servers } = (await team.admin.request('GET', '/api/servers')).json();
      const found = servers.find((s: { slug: string }) => s.slug === 'store-acme');
      expect(found).toMatchObject({ status: 'connected', managedBy: 'store operator' });
      return found;
    });

    // By hand, a managed server can only be switched on or off.
    expect(
      (await team.admin.request('PATCH', `/api/servers/${server.id}`, { url: 'http://x.test/' }))
        .statusCode,
    ).toBe(409);
    expect((await team.admin.request('DELETE', `/api/servers/${server.id}`)).statusCode).toBe(409);
    expect(
      (await team.admin.request('PATCH', `/api/servers/${server.id}`, { enabled: false }))
        .statusCode,
    ).toBe(200);

    const remove = await h.app.inject({
      method: 'DELETE',
      url: '/internal/upstreams/store-acme',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    });
    expect(remove.statusCode).toBe(204);
    const { servers } = (await team.admin.request('GET', '/api/servers')).json();
    expect(servers.some((s: { slug: string }) => s.slug === 'store-acme')).toBe(false);
  }, 20_000);
});
