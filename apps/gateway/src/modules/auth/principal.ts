import type { Role } from '@ahjin/contracts';
import type { FastifyRequest } from 'fastify';
import { AppError, forbidden, unauthorized } from '../../lib/errors';

/** The signed-in dashboard user making a request. */
export interface Principal {
  userId: string;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

/**
 * Every route checks access on the server, whatever the dashboard shows. A user who must change
 * their password can only reach the routes that let them do so.
 */
export function requireUser(
  request: FastifyRequest,
  options: { allowPasswordChange?: boolean } = {},
): Principal {
  const principal = request.principal;
  if (!principal) throw unauthorized();
  if (principal.mustChangePassword && !options.allowPasswordChange) {
    throw new AppError(403, 'password_change_required', 'Change your password before continuing.');
  }
  return principal;
}

export function requireAdmin(request: FastifyRequest): Principal {
  const principal = requireUser(request);
  if (principal.role !== 'admin') throw forbidden('Only admins can do that.');
  return principal;
}
