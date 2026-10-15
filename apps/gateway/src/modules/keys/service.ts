import {
  apiKeyPrefix,
  type ApiKey,
  type CreateApiKeyRequest,
  type CreatedApiKey,
  type Role,
} from '@urumi/contracts';
import { and, count, desc, eq, gt, isNull, or } from 'drizzle-orm';
import type { GatewayContext } from '../../context';
import { apiKeys, users } from '../../db/schema';
import { digestsEqual, hmacSha256, randomAlphanumeric, randomToken } from '../../lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { iso } from '../../lib/http';
import type { Principal } from '../auth/principal';

const MAX_ACTIVE_KEYS = 10;
const TOUCH_MS = 60_000; // write last_used_at at most once a minute per key
const DAY_MS = 24 * 60 * 60 * 1000;

type KeyRow = typeof apiKeys.$inferSelect;

const toDto = (row: KeyRow): ApiKey => ({
  id: row.id,
  userId: row.userId,
  name: row.name,
  prefix: row.prefix,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: iso(row.lastUsedAt),
  expiresAt: iso(row.expiresAt),
  revokedAt: iso(row.revokedAt),
});

/**
 * Creates a key and returns its plaintext exactly once. Members issue keys for themselves; admins
 * may issue for anyone. Format: umcp_<8-char prefix>_<43-char secret>. Only an HMAC of the whole
 * key (with a server-side pepper) is stored.
 */
export async function issueKey(
  ctx: GatewayContext,
  actor: Principal,
  input: CreateApiKeyRequest,
): Promise<CreatedApiKey> {
  const ownerId = input.userId ?? actor.userId;
  if (ownerId !== actor.userId && actor.role !== 'admin')
    throw forbidden('Only admins can issue keys for others.');

  const [owner] = await ctx.db.select().from(users).where(eq(users.id, ownerId)).limit(1);
  if (!owner) throw notFound('User');
  if (owner.status !== 'active') throw badRequest('Keys can only be issued to active users.');

  const now = ctx.now();
  const [{ active } = { active: 0 }] = await ctx.db
    .select({ active: count() })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, ownerId),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
      ),
    );
  if (active >= MAX_ACTIVE_KEYS)
    throw conflict(`A user can have at most ${MAX_ACTIVE_KEYS} active keys.`);

  const prefix = randomAlphanumeric(8);
  const key = `umcp_${prefix}_${randomToken(32)}`;
  const [row] = await ctx.db
    .insert(apiKeys)
    .values({
      userId: ownerId,
      name: input.name,
      prefix,
      keyHash: hmacSha256(ctx.settings.apiKeyPepper, key),
      createdBy: actor.userId,
      createdAt: now,
      expiresAt: input.expiresInDays
        ? new Date(now.getTime() + input.expiresInDays * DAY_MS)
        : null,
    })
    .returning();
  return { ...toDto(row!), key };
}

/** Members see their own keys; admins can list anyone's. */
export async function listKeys(
  ctx: GatewayContext,
  actor: Principal,
  userId?: string,
): Promise<ApiKey[]> {
  const target = userId ?? actor.userId;
  if (target !== actor.userId && actor.role !== 'admin') throw forbidden();
  const rows = await ctx.db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, target))
    .orderBy(desc(apiKeys.createdAt));
  return rows.map(toDto);
}

/** Owners and admins can revoke. Revocation takes effect on the key's very next request (no cache). */
export async function revokeKey(
  ctx: GatewayContext,
  actor: Principal,
  keyId: string,
): Promise<ApiKey> {
  const [row] = await ctx.db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).limit(1);
  if (!row) throw notFound('API key');
  if (row.userId !== actor.userId && actor.role !== 'admin') throw forbidden();
  if (row.revokedAt) return toDto(row);
  const [updated] = await ctx.db
    .update(apiKeys)
    .set({ revokedAt: ctx.now(), revokedBy: actor.userId })
    .where(eq(apiKeys.id, keyId))
    .returning();
  return toDto(updated!);
}

export interface KeyPrincipal {
  userId: string;
  email: string;
  name: string;
  role: Role;
  apiKeyId: string;
}

/** Outcome of checking a presented key. Failures carry the owner when known, so denials can be audited. */
export type KeyCheck =
  | { ok: true; principal: KeyPrincipal }
  | {
      ok: false;
      reason: 'malformed' | 'unknown' | 'revoked' | 'expired' | 'user_disabled';
      userId?: string;
      apiKeyId?: string;
    };

export async function verifyApiKey(ctx: GatewayContext, rawKey: string): Promise<KeyCheck> {
  const prefix = apiKeyPrefix(rawKey);
  if (!prefix) return { ok: false, reason: 'malformed' };

  const [row] = await ctx.db
    .select({ key: apiKeys, user: users })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(eq(apiKeys.prefix, prefix))
    .limit(1);
  // A wrong secret with a real prefix is treated as unknown: the prefix alone is not a credential.
  if (!row || !digestsEqual(hmacSha256(ctx.settings.apiKeyPepper, rawKey), row.key.keyHash)) {
    return { ok: false, reason: 'unknown' };
  }

  const owner = { userId: row.user.id, apiKeyId: row.key.id };
  const now = ctx.now();
  if (row.key.revokedAt) return { ok: false, reason: 'revoked', ...owner };
  if (row.key.expiresAt && row.key.expiresAt <= now)
    return { ok: false, reason: 'expired', ...owner };
  if (row.user.status !== 'active') return { ok: false, reason: 'user_disabled', ...owner };

  if (!row.key.lastUsedAt || row.key.lastUsedAt.getTime() + TOUCH_MS <= now.getTime()) {
    await ctx.db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.key.id));
  }
  return {
    ok: true,
    principal: {
      userId: row.user.id,
      email: row.user.email,
      name: row.user.name,
      role: row.user.role,
      apiKeyId: row.key.id,
    },
  };
}
