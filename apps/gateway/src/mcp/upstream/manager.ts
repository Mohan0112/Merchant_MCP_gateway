import { EventEmitter } from 'node:events';
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import type { GatewayContext } from '../../context';
import { upstreamServers, upstreamTools } from '../../db/schema';
import { decryptSecret } from '../../lib/crypto';
import type { UpstreamClientFactory, UpstreamTarget, UpstreamTool } from './client';
import {
  DEFAULT_CONNECTION_OPTIONS,
  UpstreamConnection,
  type ConnectionOptions,
  type ConnectionState,
} from './connection';
import { definitionHash, ToolPins, type ApprovedTool, type ToolReview } from './pinning';

export type ServerRow = typeof upstreamServers.$inferSelect;
type ToolRow = typeof upstreamTools.$inferSelect;

/** A connected upstream as the catalog sees it. */
export interface LiveUpstream {
  serverId: string;
  slug: string;
  displayName: string;
  timeoutMs: number;
  tools: UpstreamTool[];
  connection: UpstreamConnection;
}

/** A tool with its pinning state, for the dashboard. */
export interface ReviewedTool {
  tool: UpstreamTool;
  review: ToolReview;
  /** The definition an admin approved, when it differs from the current one. */
  approved?: UpstreamTool;
}

/** A stored tool row as the definition the upstream sent. */
export function toolFromRow(row: ToolRow): UpstreamTool {
  return {
    name: row.name,
    title: row.title ?? undefined,
    description: row.description ?? undefined,
    inputSchema: (row.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
    outputSchema: (row.outputSchema as Record<string, unknown> | null) ?? undefined,
    annotations: (row.annotations as Record<string, unknown> | null) ?? undefined,
  };
}

/** Builds the request headers that carry an upstream's credential. Never leaves the gateway. */
export function targetFor(row: ServerRow, credentialKey: Buffer): UpstreamTarget {
  let credential: string | null = null;
  if (row.credentialCiphertext && row.credentialIv && row.credentialTag) {
    credential = decryptSecret(
      { ciphertext: row.credentialCiphertext, iv: row.credentialIv, tag: row.credentialTag },
      credentialKey,
    );
  }
  const headers: Record<string, string> = {};
  if (row.authType === 'bearer' && credential) headers.Authorization = `Bearer ${credential}`;
  if (row.authType === 'header' && credential && row.authHeaderName)
    headers[row.authHeaderName] = credential;
  return { url: row.url, headers };
}

interface LiveEntry {
  row: ServerRow;
  connection: UpstreamConnection;
  pins: ToolPins;
}

/**
 * Owns one UpstreamConnection per enabled server. Persists status changes and tool lists so the
 * dashboard shows sensible data after a restart, keeps each server's approved tool definitions
 * (pinning), and emits `catalog.changed` whenever the set of available tools may have changed.
 */
export class UpstreamManager extends EventEmitter {
  private readonly live = new Map<string, LiveEntry>();

  constructor(
    private readonly ctx: GatewayContext,
    private readonly factory: UpstreamClientFactory,
    private readonly options: ConnectionOptions = DEFAULT_CONNECTION_OPTIONS,
  ) {
    super();
  }

  async start(): Promise<void> {
    const rows = await this.ctx.db.select().from(upstreamServers);
    await Promise.all(rows.filter((row) => row.enabled).map((row) => this.open(row)));
    this.ctx.logger.info(
      { servers: rows.length, enabled: this.live.size },
      'upstream manager started',
    );
  }

  /** Re-reads a server after it was created or edited, and reconnects (or stays closed if disabled). */
  async reload(serverId: string): Promise<void> {
    await this.close(serverId);
    const [row] = await this.ctx.db
      .select()
      .from(upstreamServers)
      .where(eq(upstreamServers.id, serverId))
      .limit(1);
    if (row?.enabled) await this.open(row);
    else if (row)
      await this.persistStatus(row.id, { status: 'disabled', reason: null, message: null });
    this.emit('catalog.changed');
  }

  async remove(serverId: string): Promise<void> {
    await this.close(serverId);
    this.emit('catalog.changed');
  }

  state(serverId: string): ConnectionState | undefined {
    return this.live.get(serverId)?.connection.snapshot();
  }

  /** Every connected server with the tools it may expose (approved definitions only). */
  connected(): LiveUpstream[] {
    const result: LiveUpstream[] = [];
    for (const { row, connection, pins } of this.live.values()) {
      const state = connection.snapshot();
      if (state.status !== 'connected') continue;
      result.push({
        serverId: row.id,
        slug: row.slug,
        displayName: row.displayName,
        timeoutMs: row.timeoutMs,
        tools: pins.visible(state.tools),
        connection,
      });
    }
    return result;
  }

  /** The server behind a slug, whatever its state (used to explain why a tool is unavailable). */
  bySlug(
    slug: string,
  ):
    | { row: ServerRow; state: ConnectionState; review(tool: string): ToolReview | null }
    | undefined {
    for (const { row, connection, pins } of this.live.values()) {
      if (row.slug !== slug) continue;
      const state = connection.snapshot();
      return {
        row,
        state,
        review: (name) => {
          const tool = state.tools.find((t) => t.name === name);
          return tool ? pins.review(tool) : null;
        },
      };
    }
    return undefined;
  }

  /** The live tools of a connected server with their pinning state, or null when not connected. */
  reviewedTools(serverId: string): ReviewedTool[] | null {
    const entry = this.live.get(serverId);
    const state = entry?.connection.snapshot();
    if (!entry || state?.status !== 'connected') return null;
    return state.tools.map((tool) => {
      const review = entry.pins.review(tool);
      const approved = review === 'changed' ? entry.pins.approvedDefinition(tool.name) : undefined;
      return { tool, review, ...(approved ? { approved } : {}) };
    });
  }

  /**
   * An admin approves the current definition of some (or all) tools awaiting review. Returns how
   * many were approved. Works for servers that aren't connected too, from the stored definitions.
   */
  async approveTools(serverId: string, actorId: string, names?: string[]): Promise<number> {
    const entry = this.live.get(serverId);
    const state = entry?.connection.snapshot();
    const current =
      state?.status === 'connected'
        ? state.tools
        : (
            await this.ctx.db
              .select()
              .from(upstreamTools)
              .where(eq(upstreamTools.serverId, serverId))
          ).map(toolFromRow);
    const pins = entry?.pins ?? (await this.loadPins(serverId, true));
    const targets = current.filter(
      (tool) => (!names || names.includes(tool.name)) && pins.review(tool) !== 'approved',
    );
    for (const tool of targets) {
      await this.ctx.db
        .update(upstreamTools)
        .set({
          approvedDefinition: tool,
          approvedHash: definitionHash(tool),
          approvedAt: this.ctx.now(),
          approvedBy: actorId,
        })
        .where(and(eq(upstreamTools.serverId, serverId), eq(upstreamTools.name, tool.name)));
      pins.approve(tool);
    }
    if (targets.length) {
      this.ctx.logger.info(
        { serverId, tools: targets.map((t) => t.name), actorId },
        'tool definitions approved',
      );
      this.emit('catalog.changed');
    }
    return targets.length;
  }

  /** Every enabled server's status and tool counts (for metrics and summaries). */
  statuses(): Array<{
    serverId: string;
    slug: string;
    displayName: string;
    status: ConnectionState['status'];
    reason: ConnectionState['reason'];
    message: string | null;
    visibleTools: number;
    pendingTools: number;
  }> {
    return [...this.live.values()].map(({ row, connection, pins }) => {
      const state = connection.snapshot();
      const visible = state.status === 'connected' ? pins.visible(state.tools).length : 0;
      return {
        serverId: row.id,
        slug: row.slug,
        displayName: row.displayName,
        status: state.status,
        reason: state.reason,
        message: state.message,
        visibleTools: visible,
        pendingTools: state.status === 'connected' ? state.tools.length - visible : 0,
      };
    });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.close(id)));
  }

  private async loadPins(serverId: string, pinned: boolean): Promise<ToolPins> {
    const rows = await this.ctx.db
      .select({
        name: upstreamTools.name,
        approvedDefinition: upstreamTools.approvedDefinition,
        approvedHash: upstreamTools.approvedHash,
      })
      .from(upstreamTools)
      .where(eq(upstreamTools.serverId, serverId));
    const approved = new Map<string, ApprovedTool>();
    for (const r of rows) {
      if (r.approvedDefinition && r.approvedHash) {
        approved.set(r.name, {
          hash: r.approvedHash,
          definition: r.approvedDefinition as UpstreamTool,
        });
      }
    }
    return new ToolPins(approved, pinned);
  }

  private async open(row: ServerRow): Promise<void> {
    const pins = await this.loadPins(row.id, row.toolsPinnedAt !== null);
    let target: UpstreamTarget;
    try {
      target = targetFor(row, this.ctx.settings.credentialKey);
    } catch (error) {
      this.ctx.logger.error(
        { err: error, slug: row.slug },
        'cannot decrypt upstream credential; check gateway-crypto',
      );
      return;
    }
    const connection = new UpstreamConnection(
      target,
      this.factory,
      (change) => this.onChange(row, connection, change),
      this.options,
      this.ctx.now,
    );
    this.live.set(row.id, { row, connection, pins });
    connection.start();
  }

  private async close(serverId: string): Promise<void> {
    const entry = this.live.get(serverId);
    if (!entry) return;
    this.live.delete(serverId);
    await entry.connection.stop();
  }

  private onChange(
    row: ServerRow,
    connection: UpstreamConnection,
    change: 'status' | 'tools',
  ): void {
    const entry = this.live.get(row.id);
    if (entry?.connection !== connection) return; // a replaced connection
    const state = connection.snapshot();
    if (change === 'status') {
      const log = state.status === 'unreachable' ? this.ctx.logger.warn : this.ctx.logger.info;
      log.call(
        this.ctx.logger,
        { slug: row.slug, status: state.status, reason: state.reason, detail: state.message },
        'upstream status changed',
      );
      void this.persistStatus(row.id, state);
    }
    if (state.status === 'connected') {
      // The first listing of a server is trusted; later changes wait for an admin.
      const trustAll = !entry.pins.isPinned;
      if (trustAll) entry.pins.trustAll(state.tools);
      else this.logPendingReview(row, entry.pins, state.tools);
      void this.persistTools(row.id, state.tools, trustAll);
    }
    this.emit('catalog.changed');
  }

  private logPendingReview(row: ServerRow, pins: ToolPins, tools: UpstreamTool[]): void {
    const pending = tools.filter((tool) => pins.review(tool) !== 'approved').map((t) => t.name);
    if (pending.length) {
      this.ctx.logger.warn(
        { slug: row.slug, tools: pending },
        'upstream tool definitions changed; hidden until an admin approves them',
      );
    }
  }

  private async persistStatus(
    serverId: string,
    state: Pick<ConnectionState, 'status' | 'reason' | 'message'>,
  ): Promise<void> {
    try {
      await this.ctx.db
        .update(upstreamServers)
        .set({
          lastStatus: state.status,
          lastError: state.reason ? `${state.reason}: ${state.message ?? ''}` : null,
          lastCheckedAt: this.ctx.now(),
        })
        .where(eq(upstreamServers.id, serverId));
    } catch (error) {
      this.ctx.logger.error({ err: error }, 'failed to persist upstream status');
    }
  }

  /** Stores the current definitions (keeping approvals) and drops tools the server no longer has. */
  private async persistTools(
    serverId: string,
    tools: UpstreamTool[],
    trustAll: boolean,
  ): Promise<void> {
    const now = this.ctx.now();
    const excluded = (column: string) => sql.raw(`excluded.${column}`);
    try {
      await this.ctx.db.transaction(async (tx) => {
        const names = tools.map((tool) => tool.name);
        await tx
          .delete(upstreamTools)
          .where(
            names.length
              ? and(eq(upstreamTools.serverId, serverId), notInArray(upstreamTools.name, names))
              : eq(upstreamTools.serverId, serverId),
          );
        if (tools.length) {
          await tx
            .insert(upstreamTools)
            .values(
              tools.map((tool) => {
                const hash = definitionHash(tool);
                return {
                  serverId,
                  name: tool.name,
                  title: tool.title ?? null,
                  description: tool.description ?? null,
                  inputSchema: tool.inputSchema,
                  outputSchema: tool.outputSchema ?? null,
                  annotations: tool.annotations ?? null,
                  definitionHash: hash,
                  ...(trustAll
                    ? { approvedDefinition: tool, approvedHash: hash, approvedAt: now }
                    : {}),
                  fetchedAt: now,
                };
              }),
            )
            .onConflictDoUpdate({
              target: [upstreamTools.serverId, upstreamTools.name],
              set: {
                title: excluded('title'),
                description: excluded('description'),
                inputSchema: excluded('input_schema'),
                outputSchema: excluded('output_schema'),
                annotations: excluded('annotations'),
                definitionHash: excluded('definition_hash'),
                fetchedAt: excluded('fetched_at'),
                ...(trustAll
                  ? {
                      approvedDefinition: excluded('approved_definition'),
                      approvedHash: excluded('approved_hash'),
                      approvedAt: excluded('approved_at'),
                    }
                  : {}),
              },
            });
        }
        if (trustAll) {
          await tx
            .update(upstreamServers)
            .set({ toolsPinnedAt: now })
            .where(and(eq(upstreamServers.id, serverId), isNull(upstreamServers.toolsPinnedAt)));
        }
      });
    } catch (error) {
      this.ctx.logger.error({ err: error }, 'failed to persist upstream tools');
    }
  }
}
