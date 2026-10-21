import type { Role, User } from '@ahjin/contracts';
import { and, asc, count, eq, isNull, ne, sql } from 'drizzle-orm';
import type { GatewayContext } from '../../context';
import { apiKeys, users } from '../../db/schema';
import { hashPassword } from '../../lib/crypto';
import { conflict, notFound } from '../../lib/errors';
import { iso } from '../../lib/http';
import type { Principal } from './principal';
import { deleteUserSessions } from './sessions';

type UserRow = typeof users.$inferSelect;

export function toUserDto(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    mustChangePassword: row.mustChangePassword,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: iso(row.lastLoginAt),
  };
}

export async function findUserByEmail(
  ctx: GatewayContext,
  email: string,
): Promise<UserRow | undefined> {
  const [row] = await ctx.db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .limit(1);
  return row;
}

export async function findUserById(ctx: GatewayContext, id: string): Promise<UserRow | undefined> {
  const [row] = await ctx.db.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}

export async function createUser(
  ctx: GatewayContext,
  input: {
    email: string;
    name: string;
    password: string;
    role: Role;
    mustChangePassword?: boolean;
  },
): Promise<UserRow> {
  const [row] = await ctx.db
    .insert(users)
    .values({
      email: input.email.toLowerCase(),
      name: input.name,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      mustChangePassword: input.mustChangePassword ?? false,
    })
    .returning();
  return row!;
}

/** On an empty database, create the first admin from the gateway-bootstrap-admin Secret. */
export async function bootstrapAdmin(
  ctx: GatewayContext,
  email: string,
  password: string,
): Promise<boolean> {
  const [{ total } = { total: 0 }] = await ctx.db.select({ total: count() }).from(users);
  if (total > 0) return false;
  await createUser(ctx, {
    email,
    name: 'Admin',
    password,
    role: 'admin',
    mustChangePassword: true,
  });
  ctx.logger.info({ email }, 'bootstrap admin created; password change required at first login');
  return true;
}

export async function listUsers(ctx: GatewayContext): Promise<User[]> {
  const rows = await ctx.db.select().from(users).orderBy(asc(users.createdAt));
  return rows.map(toUserDto);
}

async function otherActiveAdmins(ctx: GatewayContext, userId: string): Promise<number> {
  const [{ total } = { total: 0 }] = await ctx.db
    .select({ total: count() })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.status, 'active'), ne(users.id, userId)));
  return total;
}

/**
 * Role and status changes. The last active admin can't be demoted or disabled. Disabling a user
 * revokes all their API keys and ends their sessions, so access stops immediately.
 */
export async function updateUser(
  ctx: GatewayContext,
  actor: Principal,
  userId: string,
  change: { role?: Role; status?: 'active' | 'disabled' },
): Promise<User> {
  const target = await findUserById(ctx, userId);
  if (!target) throw notFound('User');

  const losesAdmin =
    target.role === 'admin' &&
    target.status === 'active' &&
    (change.role === 'member' || change.status === 'disabled');
  if (losesAdmin && (await otherActiveAdmins(ctx, userId)) === 0) {
    throw conflict('At least one active admin is required.');
  }

  const [updated] = await ctx.db
    .update(users)
    .set({
      ...(change.role ? { role: change.role } : {}),
      ...(change.status ? { status: change.status } : {}),
    })
    .where(eq(users.id, userId))
    .returning();

  if (change.status === 'disabled') {
    await ctx.db
      .update(apiKeys)
      .set({ revokedAt: ctx.now(), revokedBy: actor.userId })
      .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)));
    await deleteUserSessions(ctx, userId);
  }
  return toUserDto(updated!);
}
