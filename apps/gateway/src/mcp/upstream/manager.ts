import { EventEmitter } from 'node:events';
import { eq } from 'drizzle-orm';
import type { GatewayContext } from '../../context';
import { upstreamServers, upstreamTools } from '../../db/schema';
import { decryptSecret, sha256 } from '../../lib/crypto';
import type { UpstreamClientFactory, UpstreamTarget, UpstreamTool } from './client';
import {
  DEFAULT_CONNECTION_OPTIONS,
  UpstreamConnection,
  type ConnectionOptions,
  type ConnectionState,
} from './connection';

export type ServerRow = typeof upstreamServers.$inferSelect;

/** A connected upstream as the catalog sees it. */
export interface LiveUpstream {
  serverId: string;
  slug: string;
  displayName: string;
  timeoutMs: number;
  tools: UpstreamTool[];
  connection: UpstreamConnection;
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

/**
 * Owns one UpstreamConnection per enabled server. Persists status changes and tool lists so the
 * dashboard shows sensible data after a restart, and emits `catalog.changed` whenever the set of
 * available tools may have changed.
 */
export class UpstreamManager extends EventEmitter {
  private readonly live = new Map<string, { row: ServerRow; connection: UpstreamConnection }>();

  constructor(
    private readonly ctx: GatewayContext,
    private readonly factory: UpstreamClientFactory,
    private readonly options: ConnectionOptions = DEFAULT_CONNECTION_OPTIONS,
  ) {
    super();
  }

  async start(): Promise<void> {
    const rows = await this.ctx.db.select().from(upstreamServers);
    for (const row of rows) if (row.enabled) this.open(row);
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
    if (row?.enabled) this.open(row);
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

  /** Every connected server with its current tools. */
  connected(): LiveUpstream[] {
    const result: LiveUpstream[] = [];
    for (const { row, connection } of this.live.values()) {
      const state = connection.snapshot();
      if (state.status !== 'connected') continue;
      result.push({
        serverId: row.id,
        slug: row.slug,
        displayName: row.displayName,
        timeoutMs: row.timeoutMs,
        tools: state.tools,
        connection,
      });
    }
    return result;
  }

  /** The server behind a slug, whatever its state (used to explain why a tool is unavailable). */
  bySlug(slug: string): { row: ServerRow; state: ConnectionState } | undefined {
    for (const { row, connection } of this.live.values()) {
      if (row.slug === slug) return { row, state: connection.snapshot() };
    }
    return undefined;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.close(id)));
  }

  private open(row: ServerRow): void {
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
    this.live.set(row.id, { row, connection });
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
    if (this.live.get(row.id)?.connection !== connection) return; // a replaced connection
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
    if (state.status === 'connected') void this.persistTools(row.id, state.tools);
    this.emit('catalog.changed');
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

  private async persistTools(serverId: string, tools: UpstreamTool[]): Promise<void> {
    try {
      await this.ctx.db.transaction(async (tx) => {
        await tx.delete(upstreamTools).where(eq(upstreamTools.serverId, serverId));
        if (tools.length === 0) return;
        await tx.insert(upstreamTools).values(
          tools.map((tool) => ({
            serverId,
            name: tool.name,
            title: tool.title ?? null,
            description: tool.description ?? null,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema ?? null,
            annotations: tool.annotations ?? null,
            definitionHash: sha256(JSON.stringify(tool)),
            fetchedAt: this.ctx.now(),
          })),
        );
      });
    } catch (error) {
      this.ctx.logger.error({ err: error }, 'failed to persist upstream tools');
    }
  }
}
