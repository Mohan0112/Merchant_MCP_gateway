import type { Invitation, Role } from '@urumi/contracts';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { GatewayContext } from '../../context';
import { invitations } from '../../db/schema';
import { randomToken, sha256 } from '../../lib/crypto';
import { AppError, conflict, notFound } from '../../lib/errors';
import { iso } from '../../lib/http';
import type { Principal } from './principal';
import { createUser, findUserByEmail } from './users';

const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

type InvitationRow = typeof invitations.$inferSelect;

const toDto = (row: InvitationRow): Invitation => ({
  id: row.id,
  email: row.email,
  role: row.role,
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
  acceptedAt: iso(row.acceptedAt),
  revokedAt: iso(row.revokedAt),
});

/** One-time link valid for 72 hours. Only the token's hash is stored; the admin copies the link (no email). */
export async function createInvitation(
  ctx: GatewayContext,
  actor: Principal,
  input: { email: string; role: Role },
): Promise<Invitation & { link: string }> {
  if (await findUserByEmail(ctx, input.email))
    throw conflict(`${input.email} already has an account.`);
  const token = randomToken();
  const now = ctx.now();
  const [row] = await ctx.db
    .insert(invitations)
    .values({
      email: input.email,
      role: input.role,
      tokenHash: sha256(token),
      invitedBy: actor.userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    })
    .returning();
  return {
    ...toDto(row!),
    link: new URL(`/invite/${token}`, ctx.settings.publicBaseUrl).toString(),
  };
}

export async function listInvitations(ctx: GatewayContext): Promise<Invitation[]> {
  const rows = await ctx.db.select().from(invitations).orderBy(desc(invitations.createdAt));
  return rows.map(toDto);
}

export async function revokeInvitation(ctx: GatewayContext, id: string): Promise<void> {
  const [row] = await ctx.db
    .update(invitations)
    .set({ revokedAt: ctx.now() })
    .where(and(eq(invitations.id, id), isNull(invitations.acceptedAt)))
    .returning({ id: invitations.id });
  if (!row) throw notFound('Pending invitation');
}

async function usableInvitation(ctx: GatewayContext, token: string): Promise<InvitationRow> {
  const [row] = await ctx.db
    .select()
    .from(invitations)
    .where(eq(invitations.tokenHash, sha256(token)))
    .limit(1);
  if (!row || row.revokedAt || row.acceptedAt || row.expiresAt <= ctx.now()) {
    throw new AppError(
      410,
      'invitation_unusable',
      'This invitation link is invalid, used or expired.',
    );
  }
  return row;
}

export async function describeInvitation(ctx: GatewayContext, token: string) {
  const row = await usableInvitation(ctx, token);
  return { email: row.email, role: row.role, expiresAt: row.expiresAt.toISOString() };
}

/** Creates the account and marks the invitation used; the caller then signs the new user in. */
export async function acceptInvitation(
  ctx: GatewayContext,
  token: string,
  input: { name: string; password: string },
) {
  const invitation = await usableInvitation(ctx, token);
  if (await findUserByEmail(ctx, invitation.email))
    throw conflict(`${invitation.email} already has an account.`);
  const user = await createUser(ctx, {
    email: invitation.email,
    name: input.name,
    password: input.password,
    role: invitation.role,
  });
  await ctx.db
    .update(invitations)
    .set({ acceptedAt: ctx.now() })
    .where(eq(invitations.id, invitation.id));
  return user;
}
