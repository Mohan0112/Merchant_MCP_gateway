import type { AuditChannel, Role } from '@urumi/contracts';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { eq } from 'drizzle-orm';
import type { GatewayContext } from '../context';
import { upstreamServers } from '../db/schema';
import { recordAudit, type AuditRecord } from '../modules/audit/service';
import type { ToolCatalog } from './catalog';
import { slugOf } from './naming';
import type { CallToolResult } from './upstream/client';
import { UpstreamCallFailed, UpstreamUnavailable } from './upstream/connection';
import { isProtocolLevelError } from './upstream/errors';
import type { UpstreamManager } from './upstream/manager';

/** Who is calling through /mcp: an API key holder (MCP client) or the chat module acting for a user. */
export interface McpPrincipal {
  userId: string;
  email: string;
  name: string;
  role: Role;
  channel: AuditChannel;
  apiKeyId: string | null;
}

export interface InvokeDeps {
  ctx: GatewayContext;
  catalog: ToolCatalog;
  manager: UpstreamManager;
}

const errorResult = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text }],
});

const textOf = (result: CallToolResult) =>
  ((result.content ?? []) as Array<{ type?: string; text?: string }>)
    .map((c) => c.text ?? '')
    .join(' ')
    .slice(0, 500);

/**
 * tools/call through the gateway (plan §8.1.5): resolve the namespaced name, check the server,
 * call the upstream with its own credential and timeout, explain every failure in words the
 * model can act on, and write one audit row per call, whatever the outcome.
 */
export async function invokeTool(
  deps: InvokeDeps,
  who: { principal: McpPrincipal; requestId: string },
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const started = Date.now();
  const tool = deps.catalog.resolve(name);
  const slug = tool?.slug ?? slugOf(name);
  const audit = (outcome: AuditRecord['outcome'], extra: Partial<AuditRecord> = {}) =>
    recordAudit(deps.ctx, {
      userId: who.principal.userId,
      apiKeyId: who.principal.apiKeyId,
      channel: who.principal.channel,
      serverId: tool?.serverId ?? null,
      serverSlug: slug,
      toolName: tool?.originalName ?? (slug ? name.slice(slug.length + 2) : name),
      durationMs: Date.now() - started,
      outcome,
      requestId: who.requestId,
      ...extra,
    });

  if (!tool) {
    // The tool isn't in the catalog. Explain a disabled or unreachable server; otherwise it's unknown.
    const [row] = slug
      ? await deps.ctx.db
          .select()
          .from(upstreamServers)
          .where(eq(upstreamServers.slug, slug))
          .limit(1)
      : [];
    if (row && !row.enabled) {
      await audit('rejected_disabled', { serverId: row.id });
      return errorResult(`Server '${slug}' is disabled by an admin. Its tools are not available.`);
    }
    const live = slug ? deps.manager.bySlug(slug) : undefined;
    if (row && live && live.state.status !== 'connected') {
      await audit('upstream_unreachable', { serverId: row.id, errorMessage: live.state.message });
      const why = live.state.reason ? ` (${live.state.reason}: ${live.state.message})` : '';
      return errorResult(
        `Server '${slug}' is unreachable right now${why}. Other servers are unaffected.`,
      );
    }
    await audit('not_found');
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
  }

  // Permission hook: every authenticated user may call every enabled tool in the core.
  // Phase 2 (Task 23) rejects disallowed tools here with outcome 'denied_policy'.

  try {
    const result = await tool.connection.callTool(tool.originalName, args, {
      timeoutMs: tool.timeoutMs,
    });
    await audit(result.isError ? 'tool_error' : 'success', {
      errorMessage: result.isError ? textOf(result) : null,
    });
    return result;
  } catch (error) {
    if (error instanceof UpstreamUnavailable) {
      await audit('upstream_unreachable', { errorMessage: error.message });
      return errorResult(
        `Server '${slug}' is unreachable right now (${error.message}). Other servers are unaffected.`,
      );
    }
    if (error instanceof UpstreamCallFailed) {
      if (error.failure.reason === 'TIMEOUT') {
        await audit('timeout', { errorMessage: error.failure.message });
        return errorResult(`Server '${slug}' did not respond within ${tool.timeoutMs / 1000}s.`);
      }
      await audit('upstream_unreachable', {
        errorMessage: `${error.failure.reason}: ${error.failure.message}`,
      });
      return errorResult(
        `Server '${slug}' failed (${error.failure.reason}: ${error.failure.message}).`,
      );
    }
    if (isProtocolLevelError(error)) {
      const message = (error as Error).message.replace(/https?:\/\/\S+/g, '[url]').slice(0, 300);
      await audit('tool_error', { errorMessage: message });
      return errorResult(`Server '${slug}' rejected the call: ${message}`);
    }
    deps.ctx.logger.error({ err: error, tool: name }, 'unexpected error calling upstream');
    await audit('upstream_unreachable', { errorMessage: 'unexpected error' });
    return errorResult(`Server '${slug}' failed unexpectedly.`);
  }
}
