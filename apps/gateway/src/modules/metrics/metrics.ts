import type { AuditOutcome } from '@ahjin/contracts';
import type { FastifyInstance } from 'fastify';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { CallObserver, ObservedCall } from '../../mcp/invoke';
import type { UpstreamManager } from '../../mcp/upstream/manager';
import type { ChatTurnResult } from '../chat/routes';

/** Outcomes that count as errors for the error-rate panels (refusals by policy are not errors). */
const ERROR_OUTCOMES = new Set<AuditOutcome>(['tool_error', 'timeout', 'upstream_unreachable']);

/**
 * Prometheus metrics of the gateway (Task 24), served on GET /metrics (internal only: the Ingress
 * doesn't route it, and the gateway's NetworkPolicy admits only Traefik and Prometheus).
 *
 * Counters and histograms are fed from the one place every tool call ends, the invoker's audit;
 * upstream gauges are read from the connection manager at scrape time, so they are never stale.
 */
export class GatewayMetrics implements CallObserver {
  readonly registry = new Registry();
  private readonly toolCalls: Counter<'server' | 'tool' | 'channel' | 'outcome'>;
  private readonly toolErrors: Counter<'server' | 'outcome'>;
  private readonly toolDuration: Histogram<'server' | 'outcome'>;
  private readonly authDenied: Counter<'reason'>;
  private readonly chatTurns: Counter<'result'>;

  constructor(manager: UpstreamManager) {
    const registers = [this.registry];
    collectDefaultMetrics({ register: this.registry, prefix: 'ahjin_gateway_' });

    this.toolCalls = new Counter({
      name: 'ahjin_tool_calls_total',
      help: 'Tool calls through the gateway, by server, tool, channel and outcome.',
      labelNames: ['server', 'tool', 'channel', 'outcome'],
      registers,
    });
    this.toolErrors = new Counter({
      name: 'ahjin_tool_call_errors_total',
      help: 'Tool calls that failed upstream (tool error, timeout, unreachable), by server.',
      labelNames: ['server', 'outcome'],
      registers,
    });
    this.toolDuration = new Histogram({
      name: 'ahjin_tool_call_duration_seconds',
      help: 'Time from receiving a tool call to answering it, by server and outcome.',
      labelNames: ['server', 'outcome'],
      buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers,
    });
    this.authDenied = new Counter({
      name: 'ahjin_mcp_auth_denied_total',
      help: 'Requests to /mcp refused before any tool ran, by reason.',
      labelNames: ['reason'],
      registers,
    });
    this.chatTurns = new Counter({
      name: 'ahjin_chat_turns_total',
      help: 'Chat turns by how they ended: answered, refused, approval, error.',
      labelNames: ['result'],
      registers,
    });

    new Gauge({
      name: 'ahjin_upstream_up',
      help: '1 when the upstream MCP server is connected, 0 otherwise; reason says why not.',
      labelNames: ['server', 'status', 'reason'],
      registers,
      collect() {
        this.reset();
        for (const s of manager.statuses()) {
          this.set(
            { server: s.slug, status: s.status, reason: s.reason ?? '' },
            s.status === 'connected' ? 1 : 0,
          );
        }
      },
    });
    new Gauge({
      name: 'ahjin_upstream_tools',
      help: 'Tools an upstream exposes through the gateway (approved definitions only).',
      labelNames: ['server'],
      registers,
      collect() {
        this.reset();
        for (const s of manager.statuses()) this.set({ server: s.slug }, s.visibleTools);
      },
    });
    new Gauge({
      name: 'ahjin_upstream_tools_pending_review',
      help: 'Tools hidden until an admin approves a changed or new definition.',
      labelNames: ['server'],
      registers,
      collect() {
        this.reset();
        for (const s of manager.statuses()) this.set({ server: s.slug }, s.pendingTools);
      },
    });
  }

  recordCall(call: ObservedCall): void {
    const server = call.server ?? 'unknown';
    this.toolCalls.inc({
      server,
      tool: call.tool ?? 'unknown',
      channel: call.channel,
      outcome: call.outcome,
    });
    if (ERROR_OUTCOMES.has(call.outcome)) this.toolErrors.inc({ server, outcome: call.outcome });
    if (call.durationMs !== null) {
      this.toolDuration.observe({ server, outcome: call.outcome }, call.durationMs / 1000);
    }
  }

  recordAuthDenied(reason: string): void {
    this.authDenied.inc({ reason });
  }

  recordChatTurn(result: ChatTurnResult): void {
    this.chatTurns.inc({ result });
  }

  register(app: FastifyInstance): void {
    app.get('/metrics', { logLevel: 'warn' }, async (_request, reply) =>
      reply.type(this.registry.contentType).send(await this.registry.metrics()),
    );
  }
}
