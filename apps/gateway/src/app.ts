import { randomUUID } from 'node:crypto';
import type { Logger } from '@ahjin/logger';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { AppError, problemHandler } from './lib/errors';

export interface AppDependencies {
  logger: Logger;
  /** Readiness: resolves when the database answers. Never checks upstream MCP servers. */
  checkDatabase: () => Promise<void>;
  version: { name: string; version: string; commit: string };
  /** Feature modules (auth, keys, servers, mcp…) add their plugins, hooks and routes here. */
  register?: (app: FastifyInstance) => Promise<void> | void;
}

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * The gateway's HTTP application. This file holds only the cross-cutting pieces (request ids,
 * error format, health, version); feature modules are plugged in through `register`.
 */
export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    // Reuse a well-formed incoming X-Request-Id (e.g. from a test or a proxy), otherwise make one.
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  app.setErrorHandler(problemHandler);
  app.setNotFoundHandler((request) => {
    throw new AppError(
      404,
      'not_found',
      `No route for ${request.method} ${request.url.split('?')[0]}.`,
    );
  });

  app.get('/livez', { logLevel: 'warn' }, async () => ({ status: 'ok' }));
  app.get('/readyz', { logLevel: 'warn' }, async (_request, reply) => {
    try {
      await deps.checkDatabase();
      return { status: 'ready' };
    } catch (error) {
      deps.logger.warn({ err: error }, 'readiness check failed: database unreachable');
      return reply.code(503).send({ status: 'not ready', reason: 'database unreachable' });
    }
  });

  app.get('/api/version', async () => deps.version);

  await deps.register?.(app);
  return app;
}
