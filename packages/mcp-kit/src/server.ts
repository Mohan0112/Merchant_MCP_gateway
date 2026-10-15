import { randomUUID } from 'node:crypto';
import { hostHeaderValidation } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { createLogger, type Logger } from '@urumi/logger';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import * as z from 'zod';
import { isAuthorized, type StaticCredential } from './credential';
import { ToolError, type ToolHandler } from './tool';

export interface McpHttpServerOptions {
  name: string;
  version: string;
  tools: ToolHandler[];
  credential: StaticCredential;
  /** Host names accepted on /mcp (DNS-rebinding protection), e.g. the Service name. */
  allowedHosts: string[];
  /** Extra fields for the shared `server_info` tool (store URL, timezone…). */
  info?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  /** Readiness check for /readyz. Keep it local: never depend on another service's health. */
  readiness?: () => Promise<boolean> | boolean;
  logger?: Logger;
}

export interface McpHttpServer {
  app: FastifyInstance;
  listen(port: number, host?: string): Promise<string>;
  close(): Promise<void>;
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function wrap(tool: ToolHandler, logger: Logger) {
  return async (input: unknown): Promise<ToolResult> => {
    try {
      const output = (await tool.execute(input as never)) as Record<string, unknown>;
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      if (error instanceof ToolError) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
      const incident = randomUUID();
      logger.error({ err: error, tool: tool.name, incident }, 'tool failed unexpectedly');
      return {
        isError: true,
        content: [
          { type: 'text', text: `${tool.name} failed unexpectedly (incident ${incident}).` },
        ],
      };
    }
  };
}

function buildServer(options: McpHttpServerOptions, logger: Logger): McpServer {
  const server = new McpServer({ name: options.name, version: options.version });
  for (const tool of options.tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      wrap(tool, logger) as never,
    );
  }
  server.registerTool(
    'server_info',
    {
      title: 'Server info',
      description: `Name, version and settings of the ${options.name} MCP server.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (async () => {
      const extra = options.info ? await options.info() : {};
      const output = { name: options.name, version: options.version, ...extra };
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      };
    }) as never,
  );
  return server;
}

/**
 * A stateless MCP server over Streamable HTTP (MCP SDK v2, ADR-0003):
 * - POST/GET/DELETE /mcp: Host allow-list, then the static credential, then the MCP handler
 * - GET /livez: process is up; GET /readyz: the readiness hook
 */
export function createMcpHttpServer(options: McpHttpServerOptions): McpHttpServer {
  const logger = options.logger ?? createLogger(options.name);
  const handler = createMcpHandler(() => buildServer(options, logger), {
    onerror: (error) => logger.warn({ err: error }, 'mcp handler error'),
  });
  const node = toNodeHandler(handler);

  // pino's Logger satisfies FastifyBaseLogger; typing it so keeps the default FastifyInstance type.
  // Request logs (method, URL, status, timing; no headers) stay on for /mcp. Probes log only warnings.
  const app = Fastify({ loggerInstance: logger as FastifyBaseLogger });

  app.get('/livez', { logLevel: 'warn' }, async () => ({ status: 'ok' }));
  app.get('/readyz', { logLevel: 'warn' }, async (_request, reply) => {
    const ready = options.readiness ? await options.readiness() : true;
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not ready' });
  });

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    onRequest: hostHeaderValidation(options.allowedHosts),
    handler: async (request, reply) => {
      if (!isAuthorized(options.credential, request.headers)) {
        logger.warn({ ip: request.ip }, 'rejected MCP request with a missing or wrong credential');
        if (options.credential.type === 'bearer') {
          reply.header('WWW-Authenticate', 'Bearer error="invalid_token"');
        }
        return reply.code(401).send({ error: 'unauthorized' });
      }
      reply.hijack();
      await node(request.raw, reply.raw, request.body);
    },
  });

  return {
    app,
    async listen(port, host = '0.0.0.0') {
      return app.listen({ port, host });
    },
    async close() {
      await handler.close();
      await app.close();
    },
  };
}

/** Close cleanly on SIGTERM/SIGINT so Kubernetes rollouts don't cut requests mid-flight. */
export function closeOnSignals(server: McpHttpServer, logger: Logger): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'shutting down');
      server
        .close()
        .catch((error: unknown) => logger.error({ err: error }, 'error during shutdown'))
        .finally(() => process.exit(0));
    });
  }
}
