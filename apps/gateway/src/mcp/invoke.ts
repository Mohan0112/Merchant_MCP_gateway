import type { AuditChannel, AuditOutcome, Role } from '@ahjin/contracts';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { eq } from 'drizzle-orm';
import type { GatewayContext } from '../context';
import { upstreamServers } from '../db/schema';
import { recordAudit, type AuditRecord } from '../modules/audit/service';
import type { CatalogTool, ToolCatalog } from './catalog';
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

/** One tools/call as the gateway received it. */
export interface CallRequest {
  principal: McpPrincipal;
  requestId: string;
  /** The exposed, namespaced name (`<slug>__<tool>`). */
  name: string;
  args: Record<string, unknown>;
}

/** Why a call was refused before it reached the upstream: audited, and shown to the caller. */
export interface Rejection {
  outcome: AuditOutcome;
  message: string;
}

/**
 * A check that runs on every resolved call before it is sent upstream (tool permissions, rate
 * limits). Guards are independent and run in order; the first rejection wins.
 */
export interface CallGuard {
  check(call: CallRequest, tool: CatalogTool): Promise<Rejection | null> | Rejection | null;
}

/** One finished tool call, for metrics. */
export interface ObservedCall {
  server: string | null;
  tool: string | null;
  channel: AuditChannel;
  outcome: AuditOutcome;
  durationMs: number | null;
}

/** Told about every finished call (the gateway's metrics). */
export interface CallObserver {
  recordCall(call: ObservedCall): void;
}

export interface InvokeDeps {
  ctx: GatewayContext;
  catalog: ToolCatalog;
  manager: UpstreamManager;
  observer?: CallObserver;
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

/** Exactly one audit row per call, whatever the outcome, with the time it took. */
class CallAudit {
  private readonly started = Date.now();
  readonly slug: string | null;

  constructor(
    private readonly ctx: GatewayContext,
    private readonly call: CallRequest,
    private readonly tool: CatalogTool | undefined,
    private readonly observer?: CallObserver,
  ) {
    this.slug = tool?.slug ?? slugOf(call.name);
  }

  get toolName(): string {
    if (this.tool) return this.tool.originalName;
    return this.slug ? this.call.name.slice(this.slug.length + 2) : this.call.name;
  }

  write(outcome: AuditOutcome, extra: Partial<AuditRecord> = {}): Promise<void> {
    const durationMs = Date.now() - this.started;
    this.observer?.recordCall({
      server: this.slug,
      tool: this.toolName,
      channel: this.call.principal.channel,
      outcome,
      durationMs,
    });
    return recordAudit(this.ctx, {
      userId: this.call.principal.userId,
      apiKeyId: this.call.principal.apiKeyId,
      channel: this.call.principal.channel,
      serverId: this.tool?.serverId ?? null,
      serverSlug: this.slug,
      toolName: this.toolName,
      durationMs,
      outcome,
      requestId: this.call.requestId,
      ...extra,
    });
  }
}

/**
 * tools/call through the gateway (plan §8.1.5): resolve the namespaced name, run the guards, call
 * the upstream with its own credential and timeout, explain every failure in words the model can
 * act on, and write one audit row per call.
 */
export class ToolInvoker {
  constructor(
    private readonly deps: InvokeDeps,
    private readonly guards: CallGuard[] = [],
  ) {}

  async invoke(call: CallRequest): Promise<CallToolResult> {
    const tool = this.deps.catalog.resolve(call.name);
    const audit = new CallAudit(this.deps.ctx, call, tool, this.deps.observer);
    if (!tool) return this.unavailable(audit, call.name);

    for (const guard of this.guards) {
      const rejection = await guard.check(call, tool);
      if (rejection) {
        await audit.write(rejection.outcome, { errorMessage: rejection.message });
        return errorResult(rejection.message);
      }
    }
    return this.execute(audit, tool, call.args);
  }

  /** The tool isn't in the catalog: explain a disabled, unreachable or changed tool, or it's unknown. */
  private async unavailable(audit: CallAudit, name: string): Promise<CallToolResult> {
    const slug = audit.slug;
    const [row] = slug
      ? await this.deps.ctx.db
          .select()
          .from(upstreamServers)
          .where(eq(upstreamServers.slug, slug))
          .limit(1)
      : [];
    if (row && !row.enabled) {
      await audit.write('rejected_disabled', { serverId: row.id });
      return errorResult(`Server '${slug}' is disabled by an admin. Its tools are not available.`);
    }
    const live = slug ? this.deps.manager.bySlug(slug) : undefined;
    if (row && live && live.state.status !== 'connected') {
      await audit.write('upstream_unreachable', {
        serverId: row.id,
        errorMessage: live.state.message,
      });
      const why = live.state.reason ? ` (${live.state.reason}: ${live.state.message})` : '';
      return errorResult(
        `Server '${slug}' is unreachable right now${why}. Other servers are unaffected.`,
      );
    }
    const review = live?.review(audit.toolName);
    if (row && review && review !== 'approved') {
      await audit.write('pending_review', { serverId: row.id });
      return errorResult(
        review === 'new'
          ? `Tool '${name}' is new on server '${slug}' and waits for an admin to approve it.`
          : `Tool '${name}' changed since an admin approved it, so it is hidden until the change is reviewed.`,
      );
    }
    await audit.write('not_found');
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
  }

  private async execute(
    audit: CallAudit,
    tool: CatalogTool,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const slug = tool.slug;
    try {
      const result = await tool.connection.callTool(tool.originalName, args, {
        timeoutMs: tool.timeoutMs,
      });
      await audit.write(result.isError ? 'tool_error' : 'success', {
        errorMessage: result.isError ? textOf(result) : null,
      });
      return result;
    } catch (error) {
      if (error instanceof UpstreamUnavailable) {
        await audit.write('upstream_unreachable', { errorMessage: error.message });
        return errorResult(
          `Server '${slug}' is unreachable right now (${error.message}). Other servers are unaffected.`,
        );
      }
      if (error instanceof UpstreamCallFailed) {
        if (error.failure.reason === 'TIMEOUT') {
          await audit.write('timeout', { errorMessage: error.failure.message });
          return errorResult(`Server '${slug}' did not respond within ${tool.timeoutMs / 1000}s.`);
        }
        await audit.write('upstream_unreachable', {
          errorMessage: `${error.failure.reason}: ${error.failure.message}`,
        });
        return errorResult(
          `Server '${slug}' failed (${error.failure.reason}: ${error.failure.message}).`,
        );
      }
      if (isProtocolLevelError(error)) {
        const message = (error as Error).message.replace(/https?:\/\/\S+/g, '[url]').slice(0, 300);
        await audit.write('tool_error', { errorMessage: message });
        return errorResult(`Server '${slug}' rejected the call: ${message}`);
      }
      this.deps.ctx.logger.error(
        { err: error, tool: tool.definition.name },
        'unexpected error calling upstream',
      );
      await audit.write('upstream_unreachable', { errorMessage: 'unexpected error' });
      return errorResult(`Server '${slug}' failed unexpectedly.`);
    }
  }
}
