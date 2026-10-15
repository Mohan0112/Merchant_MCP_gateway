import type { FastifyInstance } from 'fastify';
import type { GatewayContext } from './context';
import { ToolCatalog } from './mcp/catalog';
import { registerMcpEndpoint } from './mcp/endpoint';
import type { UpstreamClientFactory } from './mcp/upstream/client';
import type { ConnectionOptions } from './mcp/upstream/connection';
import { withTimeout } from './mcp/upstream/errors';
import { UpstreamManager } from './mcp/upstream/manager';
import { registerAuditRoutes } from './modules/audit/routes';
import { registerAuthPlugin, registerAuthRoutes } from './modules/auth/routes';
import type { LlmProvider } from './modules/chat/llm';
import { registerChatRoutes } from './modules/chat/routes';
import { ChatTokenStore } from './modules/chat/tokens';
import { registerKeyRoutes } from './modules/keys/routes';
import { registerServerRoutes } from './modules/servers/routes';

export interface GatewayModuleOptions {
  /** How upstream MCP connections are made: the SDK in production, the same SDK against in-process servers in tests. */
  factory: UpstreamClientFactory;
  connection?: ConnectionOptions;
  /** null when no LLM key is configured. */
  provider: LlmProvider | null;
  allowedHosts: string[];
  version: string;
  /** Loopback URL of this process's /mcp endpoint, for the chat agent. */
  mcpUrl: () => string;
  /** How long close() waits for in-flight MCP exchanges (default 5 s). */
  closeGraceMs?: number;
}

export interface GatewayModules {
  manager: UpstreamManager;
  catalog: ToolCatalog;
  chatTokens: ChatTokenStore;
  /** Adds every route to the app. */
  register(app: FastifyInstance): Promise<void>;
  /** Connects to the registered upstream servers. */
  start(): Promise<void>;
  close(): Promise<void>;
}

/** Wires the feature modules together. main.ts and the test harness both use this, so tests run the real wiring. */
export function createGatewayModules(
  ctx: GatewayContext,
  options: GatewayModuleOptions,
): GatewayModules {
  const manager = new UpstreamManager(ctx, options.factory, options.connection);
  const catalog = new ToolCatalog(manager);
  const chatTokens = new ChatTokenStore(ctx.now);
  let endpoint: { close(): Promise<void> } | undefined;

  return {
    manager,
    catalog,
    chatTokens,
    async register(app) {
      await registerAuthPlugin(app, ctx);
      registerAuthRoutes(app, ctx);
      registerKeyRoutes(app, ctx);
      registerServerRoutes(app, { ctx, manager, factory: options.factory });
      registerAuditRoutes(app, ctx);
      registerChatRoutes(app, {
        ctx,
        chatTokens,
        provider: options.provider,
        mcpUrl: options.mcpUrl,
      });
      endpoint = registerMcpEndpoint(app, {
        ctx,
        catalog,
        manager,
        chatTokens,
        allowedHosts: options.allowedHosts,
        version: options.version,
      });
    },
    start: () => manager.start(),
    async close() {
      // MCP SDK 2.3 can wait forever on an exchange whose client gave up mid-call; shutdown must not.
      await withTimeout(
        endpoint?.close() ?? Promise.resolve(),
        options.closeGraceMs ?? 5000,
        'closing /mcp',
      ).catch(() =>
        ctx.logger.warn('in-flight MCP exchanges did not finish in time; closing anyway'),
      );
      await manager.stopAll();
    },
  };
}

/**
 * Graceful shutdown, bounded: end MCP streams and in-flight exchanges, stop upstream connections,
 * then let the HTTP server drain. Whatever is still open after `graceMs` is cut, so a stuck client
 * can never keep a pod in Terminating until Kubernetes kills it.
 */
export async function shutdown(
  app: FastifyInstance,
  modules: GatewayModules,
  graceMs: number,
): Promise<void> {
  const force = setTimeout(() => app.server.closeAllConnections(), graceMs);
  try {
    await modules.close();
    await app.close();
  } finally {
    clearTimeout(force);
  }
}
