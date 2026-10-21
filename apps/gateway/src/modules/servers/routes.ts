import {
  ApproveToolsRequestSchema,
  CreateServerRequestSchema,
  TestConnectionRequestSchema,
  UpdateServerRequestSchema,
} from '@ahjin/contracts';
import type { FastifyInstance } from 'fastify';
import * as z from 'zod';
import { parse } from '../../lib/http';
import { requireAdmin, requireUser } from '../auth/principal';
import {
  approveTools,
  createServer,
  deleteServer,
  getServer,
  listServers,
  refreshServer,
  testConnection,
  updateServer,
  type ServersDeps,
} from './service';

const IdParams = z.object({ id: z.uuid() });

/** Everyone sees servers, status and tools; only admins see URLs and can change anything. */
export function registerServerRoutes(app: FastifyInstance, deps: ServersDeps) {
  app.get('/api/servers', async (request) => ({
    servers: await listServers(deps, requireUser(request)),
  }));

  app.get('/api/servers/:id', async (request) =>
    getServer(deps, requireUser(request), parse(IdParams, request.params).id),
  );

  app.post('/api/servers', async (request, reply) => {
    const actor = requireAdmin(request);
    const server = await createServer(deps, actor, parse(CreateServerRequestSchema, request.body));
    return reply.code(201).send({ server });
  });

  app.patch('/api/servers/:id', async (request) => {
    const actor = requireAdmin(request);
    const { id } = parse(IdParams, request.params);
    return {
      server: await updateServer(deps, actor, id, parse(UpdateServerRequestSchema, request.body)),
    };
  });

  app.delete('/api/servers/:id', async (request, reply) => {
    requireAdmin(request);
    await deleteServer(deps, parse(IdParams, request.params).id);
    return reply.code(204).send();
  });

  app.post('/api/servers/:id/refresh', async (request) => {
    const actor = requireAdmin(request);
    return { server: await refreshServer(deps, actor, parse(IdParams, request.params).id) };
  });

  app.post('/api/servers/:id/tools/approve', async (request) => {
    const actor = requireAdmin(request);
    const { id } = parse(IdParams, request.params);
    const { names } = parse(ApproveToolsRequestSchema, request.body ?? {});
    return approveTools(deps, actor, id, names);
  });

  app.post('/api/servers/test', async (request) => {
    requireAdmin(request);
    return { result: await testConnection(deps, parse(TestConnectionRequestSchema, request.body)) };
  });
}
