import { CreateApiKeyRequestSchema } from '@urumi/contracts';
import type { FastifyInstance } from 'fastify';
import * as z from 'zod';
import type { GatewayContext } from '../../context';
import { parse } from '../../lib/http';
import { requireUser } from '../auth/principal';
import { issueKey, listKeys, revokeKey } from './service';

export function registerKeyRoutes(app: FastifyInstance, ctx: GatewayContext) {
  app.get('/api/api-keys', async (request) => {
    const actor = requireUser(request);
    const { userId } = parse(z.object({ userId: z.uuid().optional() }), request.query);
    return { keys: await listKeys(ctx, actor, userId) };
  });

  app.post('/api/api-keys', async (request, reply) => {
    const actor = requireUser(request);
    const created = await issueKey(ctx, actor, parse(CreateApiKeyRequestSchema, request.body));
    // The only response that ever contains the plaintext key.
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send({ key: created });
  });

  app.delete('/api/api-keys/:id', async (request) => {
    const actor = requireUser(request);
    const { id } = parse(z.object({ id: z.uuid() }), request.params);
    return { key: await revokeKey(ctx, actor, id) };
  });
}
