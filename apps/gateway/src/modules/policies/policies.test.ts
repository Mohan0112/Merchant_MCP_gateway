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
import { ScriptedProvider } from '../chat/llm';
import { PermissionSet } from './service';

type Row = ConstructorParameters<typeof PermissionSet>[0][number];
const rule = (over: Partial<Row>): Row =>
  ({
    id: crypto.randomUUID(),
    subjectType: 'role',
    role: 'member',
    userId: null,
    serverSlug: '*',
    toolPattern: '*',
    scope: 'all',
    effect: 'deny',
    note: null,
    createdBy: null,
    createdAt: new Date(),
    ...over,
  }) as Row;

const write = { slug: 'woo', tool: 'create_product', readOnly: false };
const read = { slug: 'woo', tool: 'list_orders', readOnly: true };

describe('PermissionSet', () => {
  it('allows everything when no rule matches', () => {
    expect(new PermissionSet([], []).decide(write)).toEqual({ allowed: true, rule: null });
  });

  it('applies "writes" rules only to tools that are not read-only', () => {
    const set = new PermissionSet([], [rule({ scope: 'writes' })]);
    expect(set.decide(write).allowed).toBe(false);
    expect(set.decide(read).allowed).toBe(true);
  });

  it("lets a user's own rule override their role's, and deny beat allow at one level", () => {
    const roleDeny = rule({ scope: 'writes' });
    const userAllow = rule({
      subjectType: 'user',
      userId: 'u',
      effect: 'allow',
      toolPattern: 'create_*',
    });
    expect(new PermissionSet([userAllow], [roleDeny]).decide(write)).toMatchObject({
      allowed: true,
      rule: userAllow,
    });
    const userDeny = rule({ subjectType: 'user', userId: 'u', serverSlug: 'woo' });
    expect(new PermissionSet([userAllow, userDeny], []).decide(write).allowed).toBe(false);
  });

  it('matches servers and tool patterns exactly, with * as the only wildcard', () => {
    const set = new PermissionSet([], [rule({ serverSlug: 'fx', toolPattern: 'convert.*' })]);
    expect(set.decide({ slug: 'fx', tool: 'convert.currency', readOnly: true }).allowed).toBe(
      false,
    );
    expect(set.decide({ slug: 'fx', tool: 'convertXcurrency', readOnly: true }).allowed).toBe(true);
    expect(set.decide({ slug: 'woo', tool: 'convert.currency', readOnly: true }).allowed).toBe(
      true,
    );
  });
});

let h: Harness;
let team: Team;
let alpha: TestUpstream;
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await h?.close();
  await alpha?.close().catch(() => {});
});

const names = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);

describe.skipIf(!databaseUrl)('tool permissions through the gateway', () => {
  it('hides denied tools, refuses direct calls, and honours per-user exceptions', async () => {
    const provider = new ScriptedProvider([{ content: 'Hello.', toolCalls: [] }]);
    h = await createHarness({ provider });
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
    const memberKey = (
      await team.member.request('POST', '/api/api-keys', { name: 'Claude Code' })
    ).json().key.key as string;
    let changes = 0;
    const member = await connectClient(baseUrl, memberKey, () => (changes += 1));
    clients.push(member);
    await eventually(async () => expect(await names(member)).toContain('alpha__cancel_order'));

    // The brief's example: members can read, only admins can change things.
    expect(
      (
        await team.member.request('POST', '/api/policies', {
          subjectType: 'role',
          role: 'member',
          effect: 'deny',
        })
      ).statusCode,
    ).toBe(403);
    const created = await team.admin.request('POST', '/api/policies', {
      subjectType: 'role',
      role: 'member',
      scope: 'writes',
      effect: 'deny',
      note: 'members can only read',
    });
    expect(created.statusCode).toBe(201);
    const roleRule = created.json().policy;

    await eventually(async () => {
      const visible = await names(member);
      expect(visible).not.toContain('alpha__cancel_order');
      expect(visible).toContain('alpha__echo');
    });
    await eventually(() => expect(changes).toBeGreaterThan(0));

    const refused = await member.callTool({ name: 'alpha__cancel_order', arguments: { id: 3 } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain(
      'You are not allowed to use alpha__cancel_order (members can only read)',
    );
    const { rows } = await h.pool.query(
      "select outcome, user_id from audit_logs where tool_name = 'cancel_order'",
    );
    expect(rows).toEqual([{ outcome: 'denied_policy', user_id: team.memberId }]);

    // The chat agent goes through the same endpoint, so it sees the member's tools only.
    await team.member.request('POST', '/api/chat', { messages: [{ role: 'user', content: 'hi' }] });
    expect(String(provider.seen[0]![0]!.content)).toContain(
      '- Alpha: tools named alpha__* (4 tools)',
    );

    // Admins aren't affected by the members' rule.
    const adminKey = (await team.admin.request('POST', '/api/api-keys', { name: 'Admin' })).json()
      .key.key as string;
    const admin = await connectClient(baseUrl, adminKey);
    clients.push(admin);
    expect(await names(admin)).toContain('alpha__cancel_order');

    // An exception for one user beats the role rule.
    await team.admin.request('POST', '/api/policies', {
      subjectType: 'user',
      userId: team.memberId,
      server: 'alpha',
      tool: 'cancel_*',
      effect: 'allow',
    });
    await eventually(async () => expect(await names(member)).toContain('alpha__cancel_order'));
    expect(
      (await member.callTool({ name: 'alpha__cancel_order', arguments: { id: 3 } })).isError,
    ).toBeFalsy();

    // The effective view: a member sees their own tools; an admin can look at anyone's.
    const own = (await team.member.request('GET', '/api/policies/effective')).json().tools;
    expect(own.find((t: { name: string }) => t.name === 'alpha__cancel_order')).toMatchObject({
      allowed: true,
      readOnly: false,
    });
    expect(
      (await team.member.request('GET', `/api/policies/effective?userId=${team.memberId}`))
        .statusCode,
    ).toBe(200);
    const adminView = await team.admin.request(
      'GET',
      `/api/policies/effective?userId=${team.memberId}`,
    );
    expect(adminView.statusCode).toBe(200);

    // Removing the rules restores the default.
    const { policies } = (await team.admin.request('GET', '/api/policies')).json();
    expect(policies).toHaveLength(2);
    for (const policy of policies) {
      expect((await team.admin.request('DELETE', `/api/policies/${policy.id}`)).statusCode).toBe(
        204,
      );
    }
    expect(roleRule.note).toBe('members can only read');
    expect((await team.admin.request('GET', '/api/policies')).json().policies).toEqual([]);
  }, 30_000);
});
