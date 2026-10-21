import { and, eq } from 'drizzle-orm';
import type { GatewayContext } from '../../context';
import { sessions, users } from '../../db/schema';
import { randomToken, sha256 } from '../../lib/crypto';
import type { Principal } from './principal';

export const SESSION_COOKIE = 'ahjin_session';
const IDLE_MS = 12 * 60 * 60 * 1000; // signed out after 12 h without activity
export const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000; // and after 7 days regardless
const TOUCH_MS = 5 * 60 * 1000; // record activity at most every 5 minutes

/** Opaque random token in the cookie; only its SHA-256 is stored, so a database leak can't hijack sessions. */
export async function createSession(
  ctx: GatewayContext,
  userId: string,
  meta: { ip?: string; userAgent?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const now = ctx.now();
  const expiresAt = new Date(now.getTime() + ABSOLUTE_MS);
  await ctx.db.insert(sessions).values({
    userId,
    tokenHash: sha256(token),
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 300),
  });
  return { token, expiresAt };
}

/** Returns the principal for a session cookie, or null if it's unknown, expired, idle or the user is disabled. */
export async function resolveSession(
  ctx: GatewayContext,
  token: string,
): Promise<Principal | null> {
  const [row] = await ctx.db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, sha256(token)))
    .limit(1);
  if (!row) return null;

  const now = ctx.now().getTime();
  const expired =
    row.session.expiresAt.getTime() <= now || row.session.lastSeenAt.getTime() + IDLE_MS <= now;
  if (expired || row.user.status !== 'active') {
    await ctx.db.delete(sessions).where(eq(sessions.id, row.session.id));
    return null;
  }
  if (row.session.lastSeenAt.getTime() + TOUCH_MS <= now) {
    await ctx.db
      .update(sessions)
      .set({ lastSeenAt: new Date(now) })
      .where(eq(sessions.id, row.session.id));
  }
  return {
    userId: row.user.id,
    email: row.user.email,
    name: row.user.name,
    role: row.user.role,
    mustChangePassword: row.user.mustChangePassword,
    sessionId: row.session.id,
  };
}

/** Whether a session id still exists and belongs to the user (chat tokens are tied to a live session). */
export async function isSessionLive(
  ctx: GatewayContext,
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .limit(1);
  return Boolean(row);
}

export async function deleteSession(ctx: GatewayContext, token: string): Promise<void> {
  await ctx.db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
}

export async function deleteUserSessions(
  ctx: GatewayContext,
  userId: string,
  exceptSessionId?: string,
): Promise<void> {
  const all = await ctx.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  for (const { id } of all) {
    if (id !== exceptSessionId) await ctx.db.delete(sessions).where(eq(sessions.id, id));
  }
}
