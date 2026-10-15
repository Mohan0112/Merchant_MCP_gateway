import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Browser, createHarness, databaseUrl, type Harness } from '../../test/harness';
import { bootstrapAdmin } from '../auth/users';
import { verifyApiKey } from './service';

let h: Harness;
let admin: Browser;
let member: Browser;
let memberId: string;

beforeEach(async () => {
  h = await createHarness();
  await bootstrapAdmin(h.ctx, 'admin@urumi.test', 'initial-admin-password');
  admin = new Browser(h.app);
  await admin.login('admin@urumi.test', 'initial-admin-password');
  await admin.request('POST', '/api/auth/password', {
    currentPassword: 'initial-admin-password',
    newPassword: 'a-new-admin-password',
  });
  const invite = await admin.request('POST', '/api/invitations', { email: 'bob@urumi.test' });
  const token = new URL(invite.json().invitation.link).pathname.split('/').pop()!;
  member = new Browser(h.app);
  memberId = (
    await member.request('POST', `/api/invitations/accept/${token}`, {
      name: 'Bob',
      password: 'bobs-long-password',
    })
  ).json().user.id;
});
afterEach(async () => {
  await h.close();
});

describe.skipIf(!databaseUrl)('API keys', () => {
  it('shows the plaintext key once and stores only an HMAC', async () => {
    const res = await member.request('POST', '/api/api-keys', { name: 'Claude Code' });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const { key } = res.json().key as { key: string; prefix: string };
    expect(key).toMatch(/^umcp_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);

    const listed = (await member.request('GET', '/api/api-keys')).json().keys;
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(key);

    const { rows } = await h.pool.query('select key_hash from api_keys');
    expect(rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].key_hash).not.toContain(key.slice(-20));
  });

  it('verifies a valid key and rejects it on the very next check after revocation', async () => {
    const created = (await member.request('POST', '/api/api-keys', { name: 'Cursor' })).json().key;
    const ok = await verifyApiKey(h.ctx, created.key);
    expect(ok).toMatchObject({
      ok: true,
      principal: { userId: memberId, role: 'member', apiKeyId: created.id },
    });

    expect((await member.request('DELETE', `/api/api-keys/${created.id}`)).statusCode).toBe(200);
    expect(await verifyApiKey(h.ctx, created.key)).toEqual({
      ok: false,
      reason: 'revoked',
      userId: memberId,
      apiKeyId: created.id,
    });
  });

  it('treats a real prefix with a wrong secret as unknown (no attribution)', async () => {
    const { key } = (await member.request('POST', '/api/api-keys', { name: 'x' })).json().key;
    const forged = `${key.slice(0, 14)}${'A'.repeat(43)}`;
    expect(await verifyApiKey(h.ctx, forged)).toEqual({ ok: false, reason: 'unknown' });
    expect(await verifyApiKey(h.ctx, 'Bearer nonsense')).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('expires keys created with a lifetime', async () => {
    const { key } = (
      await member.request('POST', '/api/api-keys', { name: 'short', expiresInDays: 1 })
    ).json().key;
    h.ctx.now = () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    expect(await verifyApiKey(h.ctx, key)).toMatchObject({
      ok: false,
      reason: 'expired',
      userId: memberId,
    });
  });

  it('lets admins issue and revoke keys for members, but not the other way round', async () => {
    const issued = await admin.request('POST', '/api/api-keys', {
      name: 'for Bob',
      userId: memberId,
    });
    expect(issued.statusCode).toBe(201);
    expect(issued.json().key.userId).toBe(memberId);

    const adminKey = (await admin.request('POST', '/api/api-keys', { name: 'mine' })).json().key;
    expect((await member.request('DELETE', `/api/api-keys/${adminKey.id}`)).statusCode).toBe(403);
    expect(
      (await member.request('GET', `/api/api-keys?userId=${adminKey.userId}`)).statusCode,
    ).toBe(403);
    expect(
      (await admin.request('DELETE', `/api/api-keys/${issued.json().key.id}`)).statusCode,
    ).toBe(200);
  });

  it('limits a user to 10 active keys', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await member.request('POST', '/api/api-keys', { name: `k${i}` })).statusCode).toBe(
        201,
      );
    }
    expect((await member.request('POST', '/api/api-keys', { name: 'k10' })).statusCode).toBe(409);
  });

  it('revokes every key when the user is disabled', async () => {
    const { key } = (await member.request('POST', '/api/api-keys', { name: 'x' })).json().key;
    await admin.request('PATCH', `/api/users/${memberId}`, { status: 'disabled' });
    expect(await verifyApiKey(h.ctx, key)).toMatchObject({
      ok: false,
      reason: 'revoked',
      userId: memberId,
    });
  });
});
