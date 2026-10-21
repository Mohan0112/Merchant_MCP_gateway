import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Browser, createHarness, databaseUrl, type Harness } from '../../test/harness';
import { bootstrapAdmin } from './users';

const ADMIN = { email: 'admin@ahjin.test', password: 'initial-admin-password' };
let h: Harness;
const clock = { now: new Date('2026-10-15T10:00:00Z') };

beforeEach(async () => {
  clock.now = new Date('2026-10-15T10:00:00Z');
  h = await createHarness({ clock });
  await bootstrapAdmin(h.ctx, ADMIN.email, ADMIN.password);
});
afterEach(async () => {
  await h.close();
});

async function adminBrowser() {
  const admin = new Browser(h.app);
  await admin.login(ADMIN.email, ADMIN.password);
  await admin.request('POST', '/api/auth/password', {
    currentPassword: ADMIN.password,
    newPassword: 'a-new-admin-password',
  });
  return admin;
}

describe.skipIf(!databaseUrl)('authentication', () => {
  it('creates the bootstrap admin only once', async () => {
    expect(await bootstrapAdmin(h.ctx, 'other@ahjin.test', 'another-password')).toBe(false);
    const { rows } = await h.pool.query('select email, role, must_change_password from users');
    expect(rows).toEqual([{ email: ADMIN.email, role: 'admin', must_change_password: true }]);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const browser = new Browser(h.app);
    const wrong = await browser.login(ADMIN.email, 'not-the-password');
    const unknown = await browser.login('nobody@ahjin.test', 'whatever-password');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().detail).toBe(unknown.json().detail);
  });

  it('sets an httpOnly SameSite=Lax session cookie and stores only its hash', async () => {
    const res = await new Browser(h.app).login(ADMIN.email, ADMIN.password);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/ahjin_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const token = /ahjin_session=([^;]+)/.exec(cookie)![1]!;
    const { rows } = await h.pool.query('select token_hash from sessions');
    expect(rows[0].token_hash).not.toContain(token);
  });

  it('forces a password change before anything else', async () => {
    const browser = new Browser(h.app);
    await browser.login(ADMIN.email, ADMIN.password);
    expect((await browser.request('GET', '/api/auth/me')).json().user.mustChangePassword).toBe(
      true,
    );
    expect((await browser.request('GET', '/api/users')).statusCode).toBe(403);
    const change = await browser.request('POST', '/api/auth/password', {
      currentPassword: ADMIN.password,
      newPassword: 'a-new-admin-password',
    });
    expect(change.statusCode).toBe(204);
    expect((await browser.request('GET', '/api/users')).statusCode).toBe(200);
  });

  it('rejects state-changing requests without the anti-CSRF header', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('csrf');
  });

  it('throttles repeated sign-in attempts', async () => {
    const browser = new Browser(h.app);
    const codes = [];
    for (let i = 0; i < 6; i++)
      codes.push((await browser.login(ADMIN.email, 'wrong-password')).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('expires idle sessions after 12 hours', async () => {
    const admin = await adminBrowser();
    expect((await admin.request('GET', '/api/auth/me')).statusCode).toBe(200);
    clock.now = new Date(clock.now.getTime() + 13 * 60 * 60 * 1000);
    expect((await admin.request('GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('signs out on logout', async () => {
    const admin = await adminBrowser();
    expect((await admin.request('POST', '/api/auth/logout')).statusCode).toBe(204);
    expect((await admin.request('GET', '/api/auth/me')).statusCode).toBe(401);
  });
});

describe.skipIf(!databaseUrl)('invitations and team management', () => {
  async function invite(admin: Browser, email: string, role = 'member') {
    const res = await admin.request('POST', '/api/invitations', { email, role });
    expect(res.statusCode).toBe(201);
    return new URL(res.json().invitation.link).pathname.split('/').pop()!;
  }

  it('lets an invitee create an account once, then signs them in as a member', async () => {
    const admin = await adminBrowser();
    const token = await invite(admin, 'Asha@Ahjin.test');

    const preview = await new Browser(h.app).request('GET', `/api/invitations/accept/${token}`);
    expect(preview.json().invitation).toMatchObject({ email: 'asha@ahjin.test', role: 'member' });

    const asha = new Browser(h.app);
    const accepted = await asha.request('POST', `/api/invitations/accept/${token}`, {
      name: 'Asha',
      password: 'ashas-long-password',
    });
    expect(accepted.statusCode).toBe(201);
    expect((await asha.request('GET', '/api/auth/me')).json().user).toMatchObject({
      role: 'member',
      name: 'Asha',
    });

    const again = await new Browser(h.app).request('POST', `/api/invitations/accept/${token}`, {
      name: 'Mallory',
      password: 'mallorys-password',
    });
    expect(again.statusCode).toBe(410);
  });

  it('rejects expired invitations', async () => {
    const admin = await adminBrowser();
    const token = await invite(admin, 'late@ahjin.test');
    clock.now = new Date(clock.now.getTime() + 73 * 60 * 60 * 1000);
    expect(
      (await new Browser(h.app).request('GET', `/api/invitations/accept/${token}`)).statusCode,
    ).toBe(410);
  });

  it('keeps members out of admin routes', async () => {
    const admin = await adminBrowser();
    const token = await invite(admin, 'member@ahjin.test');
    const member = new Browser(h.app);
    await member.request('POST', `/api/invitations/accept/${token}`, {
      name: 'M',
      password: 'members-password',
    });
    expect((await member.request('GET', '/api/users')).statusCode).toBe(403);
    expect(
      (await member.request('POST', '/api/invitations', { email: 'x@ahjin.test' })).statusCode,
    ).toBe(403);
  });

  it('never lets the last active admin be demoted or disabled', async () => {
    const admin = await adminBrowser();
    const me = (await admin.request('GET', '/api/auth/me')).json().user;
    const demote = await admin.request('PATCH', `/api/users/${me.id}`, { role: 'member' });
    expect(demote.statusCode).toBe(409);
    const disable = await admin.request('PATCH', `/api/users/${me.id}`, { status: 'disabled' });
    expect(disable.statusCode).toBe(409);
  });

  it('disabling a member ends their sessions immediately', async () => {
    const admin = await adminBrowser();
    const token = await invite(admin, 'leaver@ahjin.test');
    const leaver = new Browser(h.app);
    const created = await leaver.request('POST', `/api/invitations/accept/${token}`, {
      name: 'Leaver',
      password: 'leavers-password',
    });
    const id = created.json().user.id;
    expect(
      (await admin.request('PATCH', `/api/users/${id}`, { status: 'disabled' })).statusCode,
    ).toBe(200);
    expect((await leaver.request('GET', '/api/auth/me')).statusCode).toBe(401);
    expect(
      (await new Browser(h.app).login('leaver@ahjin.test', 'leavers-password')).statusCode,
    ).toBe(401);
  });
});
