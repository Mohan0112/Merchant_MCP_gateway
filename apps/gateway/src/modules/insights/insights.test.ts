import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, databaseUrl, eventually, type Harness } from '../../test/harness';
import {
  connectClient,
  createTeam,
  startUpstream,
  type Team,
  type TestUpstream,
} from '../../test/upstreams';

let h: Harness;
let team: Team;
let alpha: TestUpstream;
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await h.close();
  await alpha?.close().catch(() => {});
});

describe.skipIf(!databaseUrl)('metrics and insights', () => {
  it('counts calls by server, tool and outcome, and reports upstream status', async () => {
    h = await createHarness();
    team = await createTeam(h);
    const baseUrl = await h.listen();
    alpha = await startUpstream('alpha', { type: 'bearer', token: 'alpha-secret' });
    await team.admin.request('POST', '/api/servers', {
      slug: 'alpha',
      displayName: 'Alpha',
      url: alpha.url,
      authType: 'bearer',
      credential: 'alpha-secret',
    });
    const key = (await team.member.request('POST', '/api/api-keys', { name: 'k' })).json().key
      .key as string;
    const client = await connectClient(baseUrl, key);
    clients.push(client);
    await eventually(async () =>
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('alpha__echo'),
    );
    await client.callTool({ name: 'alpha__echo', arguments: { text: 'a' } });
    await client.callTool({ name: 'alpha__echo', arguments: { text: 'b' } });
    await client.callTool({ name: 'alpha__fail', arguments: {} });

    // Prometheus text format on the internal /metrics endpoint.
    const metrics = (await h.app.inject({ method: 'GET', url: '/metrics' })).payload;
    expect(metrics).toContain(
      'ahjin_tool_calls_total{server="alpha",tool="echo",channel="mcp_client",outcome="success"} 2',
    );
    expect(metrics).toContain(
      'ahjin_tool_call_errors_total{server="alpha",outcome="tool_error"} 1',
    );
    expect(metrics).toContain('ahjin_upstream_up{server="alpha",status="connected",reason=""} 1');
    expect(metrics).toContain('ahjin_upstream_tools{server="alpha"} 5');
    expect(metrics).toMatch(/ahjin_tool_call_duration_seconds_bucket\{.*server="alpha"/);
    expect(metrics).toContain('ahjin_gateway_process_cpu_seconds_total');

    // The same calls from the audit log, for the dashboard.
    const view = (await team.admin.request('GET', '/api/insights?hours=24')).json();
    expect(view.ownOnly).toBe(false);
    expect(view.totals).toMatchObject({ calls: 3, errors: 1, refused: 0, mcpClient: 3, chat: 0 });
    const server = view.servers.find((s: { server: string }) => s.server === 'alpha');
    expect(server).toMatchObject({
      displayName: 'Alpha',
      status: 'connected',
      calls: 3,
      errors: 1,
      lastError: 'Order 999 not found',
    });
    expect(server.p50Ms).not.toBeNull();
    expect(view.timeline.length).toBeGreaterThanOrEqual(24);
    expect(
      view.timeline.reduce(
        (n: number, t: { ok: number; errors: number }) => n + t.ok + t.errors,
        0,
      ),
    ).toBe(3);
    expect(view.topTools[0]).toEqual({ server: 'alpha', tool: 'echo', calls: 2, errors: 0 });

    // A member's view covers their own calls only.
    const own = (await team.member.request('GET', '/api/insights')).json();
    expect(own.ownOnly).toBe(true);
    expect(own.totals.calls).toBe(3);
    const adminOwnCalls = await team.admin.request('GET', '/api/insights?hours=0');
    expect(adminOwnCalls.statusCode).toBe(400);
  }, 30_000);
});
