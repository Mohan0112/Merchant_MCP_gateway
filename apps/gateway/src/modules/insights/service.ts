import { InsightsQuerySchema, type Insights, type ServerInsight } from '@ahjin/contracts';
import { sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { GatewayContext } from '../../context';
import { parse } from '../../lib/http';
import type { UpstreamManager } from '../../mcp/upstream/manager';
import { requireUser, type Principal } from '../auth/principal';

const ERRORS = sql`outcome in ('tool_error', 'timeout', 'upstream_unreachable')`;
const REFUSED = sql`outcome in ('denied_policy', 'rejected_disabled', 'pending_review', 'not_found')`;

const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
const numOrNull = (value: unknown) =>
  value === null || value === undefined ? null : Math.round(Number(value));

/**
 * Observability from the audit log (Task 24): per-server call volume, error rate and latency,
 * hourly volume and the busiest tools, next to each upstream's live status. Admins see the whole
 * team; members see their own calls only, like the audit log itself. Prometheus metrics cover
 * the same ground for operators (GET /metrics).
 */
export async function insights(
  ctx: GatewayContext,
  manager: UpstreamManager,
  viewer: Principal,
  hours: number,
): Promise<Insights> {
  const ownOnly = viewer.role !== 'admin';
  const since = new Date(ctx.now().getTime() - hours * 3_600_000);
  const scope: SQL = ownOnly
    ? sql`occurred_at >= ${since} and user_id = ${viewer.userId} and tool_name is not null`
    : sql`occurred_at >= ${since} and tool_name is not null`;

  const [servers, timeline, tools, totals] = await Promise.all([
    ctx.db.execute(sql`
      select server_slug as server,
        count(*) as calls,
        count(*) filter (where ${ERRORS}) as errors,
        count(*) filter (where ${REFUSED}) as refused,
        percentile_cont(0.5) within group (order by duration_ms) filter (where outcome = 'success') as p50,
        percentile_cont(0.95) within group (order by duration_ms) filter (where outcome = 'success') as p95,
        (array_agg(error_message order by occurred_at desc) filter (where ${ERRORS}))[1] as last_error
      from audit_logs where ${scope} and server_slug is not null
      group by server_slug order by calls desc`),
    ctx.db.execute(sql`
      select floor(extract(epoch from occurred_at) / 3600) * 3600 as at,
        count(*) filter (where not (${ERRORS}) and not (${REFUSED})) as ok,
        count(*) filter (where ${ERRORS}) as errors,
        count(*) filter (where ${REFUSED}) as refused
      from audit_logs where ${scope}
      group by 1 order by 1`),
    ctx.db.execute(sql`
      select server_slug as server, tool_name as tool, count(*) as calls,
        count(*) filter (where ${ERRORS}) as errors
      from audit_logs where ${scope} and server_slug is not null
      group by 1, 2 order by calls desc limit 8`),
    ctx.db.execute(sql`
      select count(*) as calls,
        count(*) filter (where ${ERRORS}) as errors,
        count(*) filter (where ${REFUSED}) as refused,
        count(*) filter (where channel = 'chat_agent') as chat,
        count(*) filter (where channel = 'mcp_client') as mcp_client
      from audit_logs where ${scope}`),
  ]);

  // Every hour of the window, so quiet hours show as zero instead of disappearing.
  const byHour = new Map(
    timeline.rows.map((r) => [
      new Date(Number(r.at) * 1000).toISOString(),
      r as Record<string, unknown>,
    ]),
  );
  const firstHour = new Date(since);
  firstHour.setUTCMinutes(0, 0, 0);
  const hoursList: Insights['timeline'] = [];
  for (let t = firstHour.getTime(); t <= ctx.now().getTime(); t += 3_600_000) {
    const key = new Date(t).toISOString();
    const row = byHour.get(key);
    hoursList.push({
      at: key,
      ok: num(row?.ok),
      errors: num(row?.errors),
      refused: num(row?.refused),
    });
  }

  const live = new Map(manager.statuses().map((s) => [s.slug, s]));
  const seen = new Set<string>();
  const serverInsights: ServerInsight[] = servers.rows.map((row) => {
    const slug = String(row.server);
    seen.add(slug);
    const state = live.get(slug);
    return {
      server: slug,
      displayName: state?.displayName ?? null,
      status: state?.status ?? null,
      reason: state?.reason ?? null,
      message: state?.message ?? null,
      calls: num(row.calls),
      errors: num(row.errors),
      refused: num(row.refused),
      p50Ms: numOrNull(row.p50),
      p95Ms: numOrNull(row.p95),
      lastError: row.last_error ? String(row.last_error) : null,
    };
  });
  // Connected servers nobody called in the window still belong in the overview.
  for (const state of live.values()) {
    if (seen.has(state.slug)) continue;
    serverInsights.push({
      server: state.slug,
      displayName: state.displayName,
      status: state.status,
      reason: state.reason,
      message: state.message,
      calls: 0,
      errors: 0,
      refused: 0,
      p50Ms: null,
      p95Ms: null,
      lastError: null,
    });
  }

  const total = totals.rows[0] ?? {};
  return {
    hours,
    ownOnly,
    totals: {
      calls: num(total.calls),
      errors: num(total.errors),
      refused: num(total.refused),
      chat: num(total.chat),
      mcpClient: num(total.mcp_client),
    },
    servers: serverInsights,
    timeline: hoursList,
    topTools: tools.rows.map((r) => ({
      server: String(r.server),
      tool: String(r.tool),
      calls: num(r.calls),
      errors: num(r.errors),
    })),
  };
}

export function registerInsightsRoutes(
  app: FastifyInstance,
  deps: { ctx: GatewayContext; manager: UpstreamManager },
) {
  app.get('/api/insights', async (request) => {
    const viewer = requireUser(request);
    const { hours } = parse(InsightsQuerySchema, request.query);
    return insights(deps.ctx, deps.manager, viewer, hours);
  });
}
