import type { AuditChannel, AuditEntry, AuditOutcome, AuditQuery } from '@urumi/contracts';
import { and, desc, eq, gte, ilike, lt, lte, type SQL } from 'drizzle-orm';
import type { GatewayContext } from '../../context';
import { auditLogs, users } from '../../db/schema';
import type { Principal } from '../auth/principal';

export interface AuditRecord {
  userId: string | null;
  apiKeyId: string | null;
  channel: AuditChannel;
  serverId?: string | null;
  serverSlug?: string | null;
  toolName?: string | null;
  durationMs?: number | null;
  outcome: AuditOutcome;
  errorMessage?: string | null;
  requestId?: string | null;
}

/**
 * Append-only: the gateway only ever inserts audit rows; no code path updates or deletes them.
 * Tool arguments are not stored (they can contain customer data, NFR-PRIV-01).
 */
export async function recordAudit(ctx: GatewayContext, record: AuditRecord): Promise<void> {
  try {
    await ctx.db.insert(auditLogs).values({
      occurredAt: ctx.now(),
      userId: record.userId,
      apiKeyId: record.apiKeyId,
      channel: record.channel,
      serverId: record.serverId ?? null,
      serverSlug: record.serverSlug ?? null,
      toolName: record.toolName ?? null,
      durationMs: record.durationMs ?? null,
      outcome: record.outcome,
      errorMessage: record.errorMessage?.slice(0, 500) ?? null,
      requestId: record.requestId ?? null,
    });
  } catch (error) {
    ctx.logger.error({ err: error, outcome: record.outcome }, 'failed to write audit entry');
  }
}

/** Newest first, cursor-paginated. Members only ever see their own entries. */
export async function queryAudit(
  ctx: GatewayContext,
  viewer: Principal,
  query: AuditQuery,
): Promise<{ entries: AuditEntry[]; nextCursor: number | null }> {
  const conditions: SQL[] = [];
  const userId = viewer.role === 'admin' ? query.userId : viewer.userId;
  if (userId) conditions.push(eq(auditLogs.userId, userId));
  if (query.server) conditions.push(eq(auditLogs.serverSlug, query.server));
  if (query.tool)
    conditions.push(ilike(auditLogs.toolName, `%${query.tool.replace(/[%_]/g, '')}%`));
  if (query.outcome) conditions.push(eq(auditLogs.outcome, query.outcome));
  if (query.channel) conditions.push(eq(auditLogs.channel, query.channel));
  if (query.from) conditions.push(gte(auditLogs.occurredAt, new Date(query.from)));
  if (query.to) conditions.push(lte(auditLogs.occurredAt, new Date(query.to)));
  if (query.cursor) conditions.push(lt(auditLogs.id, query.cursor));

  const rows = await ctx.db
    .select({ log: auditLogs, email: users.email, name: users.name })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.userId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditLogs.id))
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit);
  return {
    entries: page.map(({ log, email, name }) => ({
      id: log.id,
      occurredAt: log.occurredAt.toISOString(),
      userId: log.userId,
      userEmail: email,
      userName: name,
      apiKeyId: log.apiKeyId,
      channel: log.channel,
      serverSlug: log.serverSlug,
      toolName: log.toolName,
      durationMs: log.durationMs,
      outcome: log.outcome,
      errorMessage: log.errorMessage,
      requestId: log.requestId,
    })),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.log.id ?? null) : null,
  };
}
