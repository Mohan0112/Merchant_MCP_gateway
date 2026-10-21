import type { FastifyInstance } from 'fastify';
import type { GatewayContext } from './context';
import { ToolCatalog } from './mcp/catalog';
import { registerMcpEndpoint } from './mcp/endpoint';
import { ToolInvoker } from './mcp/invoke';
import { PolicyGuard } from './mcp/policy-guard';
import type { UpstreamClientFactory } from './mcp/upstream/client';
import type { ConnectionOptions } from './mcp/upstream/connection';
import { withTimeout } from './mcp/upstream/errors';
import { UpstreamManager } from './mcp/upstream/manager';
import type { UpstreamUrlGuard } from './mcp/upstream/url-guard';
import { registerAuditRoutes } from './modules/audit/routes';
import { registerAuthPlugin, registerAuthRoutes } from './modules/auth/routes';
import type { LlmProvider } from './modules/chat/llm';
import { ApprovalTokens } from './modules/chat/approvals';
import { registerChatRoutes } from './modules/chat/routes';
import { ChatTokenStore } from './modules/chat/tokens';
import { registerKeyRoutes } from './modules/keys/routes';
import { registerPolicyRoutes } from './modules/policies/routes';
import { ToolPolicies } from './modules/policies/service';
import { registerServerRoutes } from './modules/servers/routes';
import { AssistantSettingsStore, registerSettingsRoutes } from './modules/settings/assistant';

export interface GatewayModuleOptions {
  /** How upstream MCP connections are made: the SDK in production, the same SDK against in-process servers in tests. */
  factory: UpstreamClientFactory;
  connection?: ConnectionOptions;
  /** SSRF protection for admin-entered upstream URLs. */
  urlGuard?: UpstreamUrlGuard;
  /** null when no LLM key is configured. */
  provider: LlmProvider | null;
  /** What the assistant is told about the business until an admin edits it (Helm value). */
  assistantContext?: string;
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
  const policies = new ToolPolicies(ctx);
  // Checks every resolved call runs through before it goes upstream, in order.
  const invoker = new ToolInvoker({ ctx, catalog, manager }, [new PolicyGuard(policies)]);
  const chatTokens = new ChatTokenStore(ctx.now);
  const approvals = new ApprovalTokens(ctx.settings.apiKeyPepper, ctx.now);
  const assistant = new AssistantSettingsStore(ctx, options.assistantContext ?? '');
  let endpoint: { close(): Promise<void> } | undefined;

  return {
    manager,
    catalog,
    chatTokens,
    async register(app) {
      await registerAuthPlugin(app, ctx);
      registerAuthRoutes(app, ctx);
      registerKeyRoutes(app, ctx);
      registerServerRoutes(app, {
        ctx,
        manager,
        factory: options.factory,
        urlGuard: options.urlGuard,
      });
      registerAuditRoutes(app, ctx);
      registerPolicyRoutes(app, {
        ctx,
        policies,
        catalog,
        // Permission changes alter what each client may list.
        onChange: () => catalog.emit('changed'),
      });
      registerSettingsRoutes(app, assistant);
      registerChatRoutes(app, {
        ctx,
        chatTokens,
        approvals,
        assistant,
        provider: options.provider,
        mcpUrl: options.mcpUrl,
      });
      endpoint = registerMcpEndpoint(app, {
        ctx,
        catalog,
        manager,
        invoker,
        policies,
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
