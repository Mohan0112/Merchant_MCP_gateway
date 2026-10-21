import fastifyCookie from '@fastify/cookie';
import {
  AcceptInvitationRequestSchema,
  ChangePasswordRequestSchema,
  CreateInvitationRequestSchema,
  LoginRequestSchema,
  UpdateUserRequestSchema,
} from '@ahjin/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as z from 'zod';
import type { GatewayContext } from '../../context';
import { users } from '../../db/schema';
import { hashPassword, verifyPassword } from '../../lib/crypto';
import { AppError, unauthorized } from '../../lib/errors';
import { parse } from '../../lib/http';
import { FixedWindowLimiter } from '../../lib/rate-limit';
import {
  acceptInvitation,
  createInvitation,
  describeInvitation,
  listInvitations,
  revokeInvitation,
} from './invitations';
import { requireAdmin, requireUser } from './principal';
import {
  ABSOLUTE_MS,
  createSession,
  deleteSession,
  deleteUserSessions,
  resolveSession,
  SESSION_COOKIE,
} from './sessions';
import { findUserByEmail, findUserById, listUsers, toUserDto, updateUser } from './users';

const IdParams = z.object({ id: z.uuid() });
const TokenParams = z.object({ token: z.string().min(16).max(128) });
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Session cookies, the principal on every request, and cross-site request protection. */
export async function registerAuthPlugin(app: FastifyInstance, ctx: GatewayContext) {
  await app.register(fastifyCookie);
  app.decorateRequest('principal', null);

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/')) return;
    // Browsers can't add custom headers cross-site without a CORS preflight, which we never allow,
    // so requiring one on writes blocks cross-site request forgery with SameSite=Lax cookies.
    if (!SAFE_METHODS.has(request.method) && !request.headers['x-requested-with']) {
      throw new AppError(403, 'csrf', 'Missing X-Requested-With header.');
    }
    const token = request.cookies[SESSION_COOKIE];
    if (token) request.principal = await resolveSession(ctx, token);
  });
}

function setSessionCookie(ctx: GatewayContext, reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.settings.cookieSecure,
    path: '/',
    maxAge: ABSOLUTE_MS / 1000,
  });
}

const clientMeta = (request: FastifyRequest) => ({
  ip: request.ip,
  userAgent: request.headers['user-agent'],
});

export function registerAuthRoutes(app: FastifyInstance, ctx: GatewayContext) {
  const loginLimiter = new FixedWindowLimiter(5, 60_000);

  app.post('/api/auth/login', async (request, reply) => {
    const { email, password } = parse(LoginRequestSchema, request.body);
    const limitKey = `${request.ip}|${email}`;
    if (!loginLimiter.tryConsume(limitKey)) {
      reply.header('Retry-After', String(loginLimiter.retryAfterSeconds(limitKey)));
      throw new AppError(429, 'rate_limited', 'Too many sign-in attempts. Try again in a minute.');
    }
    const user = await findUserByEmail(ctx, email);
    // Same answer for unknown email and wrong password, so accounts can't be discovered.
    if (!user || user.status !== 'active' || !(await verifyPassword(password, user.passwordHash))) {
      throw unauthorized('Email or password is incorrect.');
    }
    loginLimiter.reset(limitKey);
    const session = await createSession(ctx, user.id, clientMeta(request));
    await ctx.db.update(users).set({ lastLoginAt: ctx.now() }).where(eq(users.id, user.id));
    setSessionCookie(ctx, reply, session.token);
    return { user: toUserDto({ ...user, lastLoginAt: ctx.now() }) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await deleteSession(ctx, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/auth/me', async (request) => {
    const principal = requireUser(request, { allowPasswordChange: true });
    const user = await findUserById(ctx, principal.userId);
    if (!user) throw unauthorized();
    return { user: toUserDto(user) };
  });

  app.post('/api/auth/password', async (request, reply) => {
    const principal = requireUser(request, { allowPasswordChange: true });
    const { currentPassword, newPassword } = parse(ChangePasswordRequestSchema, request.body);
    if (newPassword === currentPassword) {
      throw new AppError(400, 'same_password', 'Choose a password different from the current one.');
    }
    const user = await findUserById(ctx, principal.userId);
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new AppError(400, 'wrong_password', 'Current password is incorrect.');
    }
    await ctx.db
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword), mustChangePassword: false })
      .where(eq(users.id, user.id));
    // Sign out every other session of this user.
    await deleteUserSessions(ctx, user.id, principal.sessionId);
    return reply.code(204).send();
  });

  // ---------- Team management (admin) ----------

  app.get('/api/users', async (request) => {
    requireAdmin(request);
    return { users: await listUsers(ctx) };
  });

  app.patch('/api/users/:id', async (request) => {
    const actor = requireAdmin(request);
    const { id } = parse(IdParams, request.params);
    return { user: await updateUser(ctx, actor, id, parse(UpdateUserRequestSchema, request.body)) };
  });

  app.get('/api/invitations', async (request) => {
    requireAdmin(request);
    return { invitations: await listInvitations(ctx) };
  });

  app.post('/api/invitations', async (request, reply) => {
    const actor = requireAdmin(request);
    const invitation = await createInvitation(
      ctx,
      actor,
      parse(CreateInvitationRequestSchema, request.body),
    );
    return reply.code(201).send({ invitation });
  });

  app.delete('/api/invitations/:id', async (request, reply) => {
    requireAdmin(request);
    await revokeInvitation(ctx, parse(IdParams, request.params).id);
    return reply.code(204).send();
  });

  // ---------- Accepting an invitation (public, the token is the credential) ----------

  app.get('/api/invitations/accept/:token', async (request) => {
    const { token } = parse(TokenParams, request.params);
    return { invitation: await describeInvitation(ctx, token) };
  });

  app.post('/api/invitations/accept/:token', async (request, reply) => {
    const { token } = parse(TokenParams, request.params);
    const user = await acceptInvitation(
      ctx,
      token,
      parse(AcceptInvitationRequestSchema, request.body),
    );
    const session = await createSession(ctx, user.id, clientMeta(request));
    setSessionCookie(ctx, reply, session.token);
    return reply.code(201).send({ user: toUserDto(user) });
  });
}
