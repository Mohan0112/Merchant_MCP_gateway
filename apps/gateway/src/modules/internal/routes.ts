import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as z from 'zod';
import { digestsEqual, sha256 } from '../../lib/crypto';
import { AppError, notFound } from '../../lib/errors';
import { parse } from '../../lib/http';
import { registerManaged, unregisterManaged, type ServersDeps } from '../servers/service';

const MANAGED_BY = 'store operator';

const RegisterBody = z.object({
  displayName: z.string().trim().min(1).max(60),
  url: z.url(),
  credential: z.string().min(16).max(4096),
  store: z.string().min(1).max(40),
});
const SlugParams = z.object({ slug: z.string().regex(/^[a-z][a-z0-9-]{1,19}$/) });

/**
 * The internal API for platform components (Task 30). Not reachable from outside: the Ingress
 * routes only /api and /mcp to the gateway, and its NetworkPolicy admits the store operator by
 * label. Callers present the shared token from Secret gateway-internal; without a configured
 * token the routes don't exist.
 */
export function registerInternalRoutes(
  app: FastifyInstance,
  deps: ServersDeps,
  token: string | undefined,
) {
  if (!token) return;
  const expected = sha256(token);
  const authorize = (request: FastifyRequest) => {
    const header = request.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!presented || !digestsEqual(sha256(presented), expected)) {
      throw new AppError(401, 'unauthorized', 'Internal token required.');
    }
  };

  app.put('/internal/upstreams/:slug', async (request) => {
    authorize(request);
    const { slug } = parse(SlugParams, request.params);
    const body = parse(RegisterBody, request.body);
    return {
      server: await registerManaged(deps, {
        slug,
        displayName: body.displayName,
        url: body.url,
        credential: body.credential,
        managedBy: MANAGED_BY,
      }),
    };
  });

  app.delete('/internal/upstreams/:slug', async (request, reply) => {
    authorize(request);
    const { slug } = parse(SlugParams, request.params);
    if (!(await unregisterManaged(deps, slug, MANAGED_BY))) throw notFound('Server');
    return reply.code(204).send();
  });
}
