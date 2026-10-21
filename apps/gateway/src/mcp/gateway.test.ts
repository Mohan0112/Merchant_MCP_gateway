import type { Client } from '@modelcontextprotocol/client';
import { createServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, databaseUrl, eventually, type Harness } from '../test/harness';
import {
  connectClient,
  createTeam,
  startUpstream,
  type Team,
  type TestUpstream,
} from '../test/upstreams';

let h: Harness;
let team: Team;
let baseUrl: string;
let alpha: TestUpstream;
let beta: TestUpstream;
const clients: Client[] = [];

beforeEach(async () => {
  h = await createHarness();
  team = await createTeam(h);
  baseUrl = await h.listen();
  alpha = await startUpstream('alpha', { type: 'bearer', token: 'alpha-secret' });
  beta = await startUpstream('beta', { type: 'header', header: 'X-API-Key', value: 'beta-secret' });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await h.close();
  await alpha.close().catch(() => {});
  await beta.close().catch(() => {});
});

async function addServer(slug: string, url: string, auth: Record<string, unknown>) {
  const res = await team.admin.request('POST', '/api/servers', {
    slug,
    displayName: slug.toUpperCase(),
    url,
    ...auth,
  });
  expect(res.statusCode).toBe(201);
  const id = res.json().server.id as string;
  await eventually(async () => {
    const server = (await team.admin.request('GET', `/api/servers/${id}`)).json().server;
    expect(server.status).toBe('connected');
  });
  return id;
}

const addAlpha = () =>
  addServer('alpha', alpha.url, { authType: 'bearer', credential: 'alpha-secret' });
const addBeta = () =>
  addServer('beta', beta.url, {
    authType: 'header',
    authHeaderName: 'X-API-Key',
    credential: 'beta-secret',
  });

async function memberClient(onToolsChanged?: () => void) {
  const { key } = (
    await team.member.request('POST', '/api/api-keys', { name: 'Claude Code' })
  ).json().key;
  const client = await connectClient(baseUrl, key, onToolsChanged);
  clients.push(client);
  return { client, key: key as string };
}

/** A port nothing listens on (port 1 won't do: fetch refuses it as a 'bad port'). */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const text = (result: unknown) =>
  (result as { content: Array<{ text: string }> }).content[0]?.text ?? '';

async function auditRows() {
  const { rows } = await h.pool.query(
    'select channel, server_slug, tool_name, outcome, error_message, user_id from audit_logs order by id',
  );
  return rows as Array<Record<string, string>>;
}

describe.skipIf(!databaseUrl)('MCP gateway', () => {
  it('aggregates the tools of every connected server under namespaced names', async () => {
    await addAlpha();
    await addBeta();
    const { client } = await memberClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'alpha__echo',
      'alpha__fail',
      'alpha__server_info',
      'alpha__slow',
      'beta__echo',
      'beta__fail',
      'beta__server_info',
      'beta__slow',
    ]);
    const echo = tools.find((t) => t.name === 'alpha__echo')!;
    expect(echo.description).toBe('[ALPHA] Returns the text it was given.');
    expect(echo.inputSchema.properties).toHaveProperty('text');
  });

  it('routes calls to the right server with its own credential and audits them', async () => {
    await addAlpha();
    await addBeta();
    const { client } = await memberClient();

    expect(text(await client.callTool({ name: 'alpha__echo', arguments: { text: 'hi' } }))).toBe(
      '{"text":"hi"}',
    );
    expect(text(await client.callTool({ name: 'beta__echo', arguments: { text: 'yo' } }))).toBe(
      '{"text":"yo"}',
    );
    const failed = await client.callTool({ name: 'alpha__fail', arguments: {} });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toBe('Order 999 not found');

    const rows = await eventually(async () => {
      const r = await auditRows();
      expect(r).toHaveLength(3);
      return r;
    });
    expect(rows.map((r) => [r.channel, r.server_slug, r.tool_name, r.outcome])).toEqual([
      ['mcp_client', 'alpha', 'echo', 'success'],
      ['mcp_client', 'beta', 'echo', 'success'],
      ['mcp_client', 'alpha', 'fail', 'tool_error'],
    ]);
    expect(rows.every((r) => r.user_id === team.memberId)).toBe(true);
    expect(rows[2]!.error_message).toBe('Order 999 not found');
  });

  it('rejects unknown tools and missing or revoked keys, auditing what it can attribute', async () => {
    await addAlpha();
    const { client, key } = await memberClient();
    await expect(client.callTool({ name: 'alpha__nope', arguments: {} })).rejects.toThrow(
      /Unknown tool/,
    );

    const noKey = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(noKey.status).toBe(401);
    expect(noKey.headers.get('www-authenticate')).toMatch(/^Bearer /);

    const keyId = (await team.member.request('GET', '/api/api-keys')).json().keys[0].id;
    await team.member.request('DELETE', `/api/api-keys/${keyId}`);
    await expect(client.listTools()).rejects.toThrow();

    const rows = await auditRows();
    expect(rows.map((r) => r.outcome)).toEqual(['not_found', 'denied_auth']);
    expect(rows[1]).toMatchObject({ user_id: team.memberId, error_message: 'API key revoked' });
    expect(key).toMatch(/^amcp_/);
  });

  it('rejects requests with a foreign Host header (DNS rebinding)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { host: 'evil.example' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('hides a disabled server, explains it, and brings it back when re-enabled', async () => {
    const id = await addAlpha();
    await addBeta();
    let changed = 0;
    const { client } = await memberClient(() => (changed += 1));

    expect(
      (await team.admin.request('PATCH', `/api/servers/${id}`, { enabled: false })).statusCode,
    ).toBe(200);
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name.startsWith('alpha__'))).toBe(false);
    expect(tools.some((t) => t.name.startsWith('beta__'))).toBe(true);
    const result = await client.callTool({ name: 'alpha__echo', arguments: { text: 'x' } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/disabled by an admin/);

    await team.admin.request('PATCH', `/api/servers/${id}`, { enabled: true });
    await eventually(async () => {
      const after = await client.listTools();
      expect(after.tools.some((t) => t.name === 'alpha__echo')).toBe(true);
    });
    expect((await auditRows()).map((r) => r.outcome)).toContain('rejected_disabled');
    await eventually(() => expect(changed).toBeGreaterThan(0));
  });

  it('keeps the other servers working when one goes down, and reconnects when it is back', async () => {
    const id = await addAlpha();
    await addBeta();
    const { client } = await memberClient();
    const port = new URL(alpha.url).port;
    await alpha.close();

    await eventually(async () => {
      const server = (await team.admin.request('GET', `/api/servers/${id}`)).json().server;
      expect(server.status).toBe('unreachable');
      expect(server.statusReason).toBe('CONNECTION_REFUSED');
    });
    const down = await client.callTool({ name: 'alpha__echo', arguments: { text: 'x' } });
    expect(down.isError).toBe(true);
    expect(text(down)).toMatch(/unreachable/);
    expect(text(await client.callTool({ name: 'beta__echo', arguments: { text: 'ok' } }))).toBe(
      '{"text":"ok"}',
    );

    // Same port again: the gateway's backoff loop finds it without anyone pressing a button.
    alpha = await startUpstream('alpha', { type: 'bearer', token: 'alpha-secret' }, Number(port));
    await eventually(async () => {
      const server = (await team.admin.request('GET', `/api/servers/${id}`)).json().server;
      expect(server.status).toBe('connected');
    }, 8000);
    expect(text(await client.callTool({ name: 'alpha__echo', arguments: { text: 'back' } }))).toBe(
      '{"text":"back"}',
    );
  });

  it('times out a slow tool with a clear message without affecting the server status', async () => {
    const id = await addServer('alpha', alpha.url, {
      authType: 'bearer',
      credential: 'alpha-secret',
      timeoutMs: 1000,
    });
    const { client } = await memberClient();
    const result = await client.callTool({ name: 'alpha__slow', arguments: { ms: 3000 } });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Server 'alpha' did not respond within 1s.");
    expect((await auditRows()).at(-1)?.outcome).toBe('timeout');
    const server = (await team.admin.request('GET', `/api/servers/${id}`)).json().server;
    expect(server.status).toBe('connected');
  });

  it('reports a wrong upstream credential as an auth problem', async () => {
    const res = await team.admin.request('POST', '/api/servers', {
      slug: 'alpha',
      displayName: 'Alpha',
      url: alpha.url,
      authType: 'bearer',
      credential: 'wrong',
    });
    const id = res.json().server.id;
    await eventually(async () => {
      const server = (await team.admin.request('GET', `/api/servers/${id}`)).json().server;
      expect(server.status).toBe('unreachable');
      expect(server.statusReason).toBe('AUTH');
    });
  });

  it('tests a connection before saving, without storing anything', async () => {
    const ok = await team.admin.request('POST', '/api/servers/test', {
      url: alpha.url,
      authType: 'bearer',
      credential: 'alpha-secret',
    });
    expect(ok.json().result).toMatchObject({
      ok: true,
      tools: ['echo', 'fail', 'slow', 'server_info'],
    });
    const bad = await team.admin.request('POST', '/api/servers/test', {
      url: `http://127.0.0.1:${await freePort()}/mcp`,
      authType: 'none',
    });
    expect(bad.json().result).toMatchObject({ ok: false, reason: 'CONNECTION_REFUSED' });
    expect((await h.pool.query('select count(*)::int as n from upstream_servers')).rows[0].n).toBe(
      0,
    );
  });

  it('lets members see servers and tools but never URLs or credentials, and not change them', async () => {
    const id = await addAlpha();
    const listed = (await team.member.request('GET', '/api/servers')).json().servers;
    expect(listed[0]).toMatchObject({
      slug: 'alpha',
      status: 'connected',
      url: null,
      hasCredential: true,
    });
    expect(JSON.stringify(listed)).not.toContain('alpha-secret');
    const detail = (await team.member.request('GET', `/api/servers/${id}`)).json();
    expect(detail.tools.map((t: { name: string }) => t.name)).toContain('echo');
    expect(
      (await team.member.request('PATCH', `/api/servers/${id}`, { enabled: false })).statusCode,
    ).toBe(403);
    expect((await team.member.request('DELETE', `/api/servers/${id}`)).statusCode).toBe(403);
    const { rows } = await h.pool.query('select credential_ciphertext from upstream_servers');
    expect(String(rows[0].credential_ciphertext)).not.toContain('alpha-secret');
  });

  it('removes a deleted server from the catalog', async () => {
    const id = await addAlpha();
    const { client } = await memberClient();
    expect((await team.admin.request('DELETE', `/api/servers/${id}`)).statusCode).toBe(204);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(0);
  });

  it('shows members only their own audit entries and admins everything, with filters', async () => {
    await addAlpha();
    const { client } = await memberClient();
    await client.callTool({ name: 'alpha__echo', arguments: { text: 'a' } });
    await client.callTool({ name: 'alpha__fail', arguments: {} });

    const mine = (await team.member.request('GET', '/api/audit-logs')).json();
    expect(mine.entries).toHaveLength(2);
    const failures = (await team.admin.request('GET', '/api/audit-logs?outcome=tool_error')).json();
    expect(failures.entries).toHaveLength(1);
    expect(failures.entries[0]).toMatchObject({
      serverSlug: 'alpha',
      toolName: 'fail',
      userEmail: 'bob@ahjin.test',
    });
    const adminOwn = (
      await team.admin.request('GET', `/api/audit-logs?userId=${team.memberId}&tool=echo`)
    ).json();
    expect(adminOwn.entries).toHaveLength(1);
  });
});
