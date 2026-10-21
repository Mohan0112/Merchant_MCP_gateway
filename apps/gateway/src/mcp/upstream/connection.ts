import type { UnreachableReason, UpstreamStatus } from '@ahjin/contracts';
import type {
  CallToolResult,
  UpstreamClient,
  UpstreamClientFactory,
  UpstreamTarget,
  UpstreamTool,
} from './client';
import { classifyError, isProtocolLevelError, type Failure } from './errors';

export interface ConnectionOptions {
  connectTimeoutMs: number;
  listTimeoutMs: number;
  healthIntervalMs: number;
  /** Consecutive failed health checks before the server is marked unreachable. */
  healthFailureThreshold: number;
  /** Consecutive failed tool calls before the server is marked unreachable. */
  callFailureThreshold: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_CONNECTION_OPTIONS: ConnectionOptions = {
  connectTimeoutMs: 5000,
  listTimeoutMs: 10_000,
  healthIntervalMs: 10_000,
  healthFailureThreshold: 2,
  callFailureThreshold: 3,
  initialBackoffMs: 1000,
  maxBackoffMs: 30_000,
};

export interface ConnectionState {
  status: UpstreamStatus;
  reason: UnreachableReason | null;
  message: string | null;
  since: Date;
  lastCheckedAt: Date | null;
  era: 'modern' | 'legacy' | null;
  tools: UpstreamTool[];
}

/** Raised for calls to a server that isn't connected, so the caller can explain why. */
export class UpstreamUnavailable extends Error {
  override name = 'UpstreamUnavailable';
  constructor(
    readonly status: UpstreamStatus,
    readonly failure: Failure | null,
  ) {
    super(failure ? `${status}: ${failure.message}` : status);
  }
}

/** Raised when a tool call fails at the transport level (timeout, refused, broken stream…). */
export class UpstreamCallFailed extends Error {
  override name = 'UpstreamCallFailed';
  constructor(readonly failure: Failure) {
    super(failure.message);
  }
}

const sameTools = (a: UpstreamTool[], b: UpstreamTool[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * One upstream server's connection lifecycle (plan §8.1.6):
 *
 *   connecting ──ok──▶ connected ──2 failed checks / 3 failed calls──▶ unreachable
 *        ▲                                                             │
 *        └───────────── backoff 1 s → 30 s (with jitter) ─────────────┘
 *   stop() from any state ──▶ disabled
 *
 * Changes are reported through `onChange`, so the manager can persist status and rebuild the catalog.
 */
export class UpstreamConnection {
  private client: UpstreamClient | undefined;
  private state: ConnectionState;
  private timer: NodeJS.Timeout | undefined;
  private backoffMs: number;
  private healthFailures = 0;
  private callFailures = 0;
  private stopped = false;
  private generation = 0;

  constructor(
    private readonly target: UpstreamTarget,
    private readonly factory: UpstreamClientFactory,
    private readonly onChange: (change: 'status' | 'tools') => void,
    private readonly options: ConnectionOptions = DEFAULT_CONNECTION_OPTIONS,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.backoffMs = options.initialBackoffMs;
    this.state = {
      status: 'connecting',
      reason: null,
      message: null,
      since: now(),
      lastCheckedAt: null,
      era: null,
      tools: [],
    };
  }

  snapshot(): ConnectionState {
    return { ...this.state, tools: [...this.state.tools] };
  }

  start(): void {
    void this.connect();
  }

  /** Disable or remove: close the connection for good. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.timer);
    await this.client?.close();
    this.client = undefined;
    this.setStatus('disabled', null);
  }

  /** Runs a health check now (e.g. after a failed call) instead of waiting for the next tick. */
  checkNow(): void {
    if (this.stopped || this.state.status !== 'connected') return;
    clearTimeout(this.timer);
    void this.healthCheck();
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<CallToolResult> {
    const client = this.client;
    if (this.state.status !== 'connected' || !client) {
      throw new UpstreamUnavailable(this.state.status, this.failureOf());
    }
    try {
      const result = await client.callTool(name, args, options);
      this.callFailures = 0;
      return result;
    } catch (error) {
      // The upstream answered with a JSON-RPC error (unknown tool, bad params): not a health problem.
      if (isProtocolLevelError(error)) throw error;
      const failure = classifyError(error);
      this.callFailures += 1;
      if (this.callFailures >= this.options.callFailureThreshold) this.markUnreachable(failure);
      else this.checkNow();
      throw new UpstreamCallFailed(failure);
    }
  }

  private failureOf(): Failure | null {
    return this.state.reason
      ? { reason: this.state.reason, message: this.state.message ?? '' }
      : null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.generation;
    // Retries of an unreachable server stay 'unreachable' until one succeeds (no status flapping).
    if (this.state.status !== 'unreachable') this.setStatus('connecting', null);
    const client = this.factory(this.target, (tools) => this.updateTools(tools));
    try {
      const { era } = await client.connect(this.options.connectTimeoutMs);
      const tools = await client.listTools(this.options.listTimeoutMs);
      if (generation !== this.generation) {
        await client.close();
        return;
      }
      this.client = client;
      this.state.era = era;
      this.state.lastCheckedAt = this.now();
      this.healthFailures = 0;
      this.callFailures = 0;
      this.backoffMs = this.options.initialBackoffMs;
      this.updateTools(tools);
      this.setStatus('connected', null);
      this.schedule(() => this.healthCheck(), this.options.healthIntervalMs);
    } catch (error) {
      await client.close().catch(() => {});
      if (generation !== this.generation) return;
      this.state.lastCheckedAt = this.now();
      this.setStatus('unreachable', classifyError(error));
      this.scheduleReconnect();
    }
  }

  private async healthCheck(): Promise<void> {
    const client = this.client;
    if (this.stopped || !client) return;
    const generation = this.generation;
    try {
      const tools = await client.listTools(this.options.listTimeoutMs);
      if (generation !== this.generation) return;
      // The server answers, so earlier failed calls were about those calls, not its health.
      this.healthFailures = 0;
      this.callFailures = 0;
      this.state.lastCheckedAt = this.now();
      this.updateTools(tools);
      this.schedule(() => this.healthCheck(), this.options.healthIntervalMs);
    } catch (error) {
      if (generation !== this.generation) return;
      this.healthFailures += 1;
      this.state.lastCheckedAt = this.now();
      if (this.healthFailures >= this.options.healthFailureThreshold)
        this.markUnreachable(classifyError(error));
      else this.schedule(() => this.healthCheck(), this.options.healthIntervalMs);
    }
  }

  private markUnreachable(failure: Failure): void {
    if (this.stopped || this.state.status === 'unreachable') return;
    this.generation++;
    const client = this.client;
    this.client = undefined;
    void client?.close();
    this.setStatus('unreachable', failure);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const jitter = Math.floor(Math.random() * Math.min(1000, this.backoffMs / 2));
    this.schedule(() => this.connect(), this.backoffMs + jitter);
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs);
  }

  private schedule(task: () => Promise<void>, ms: number): void {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => void task(), ms);
    this.timer.unref?.();
  }

  private updateTools(tools: UpstreamTool[]): void {
    if (sameTools(tools, this.state.tools)) return;
    this.state.tools = tools;
    if (this.state.status === 'connected') this.onChange('tools');
  }

  private setStatus(status: UpstreamStatus, failure: Failure | null): void {
    const changed =
      status !== this.state.status ||
      (failure?.reason ?? null) !== this.state.reason ||
      (failure?.message ?? null) !== this.state.message;
    if (status !== this.state.status) this.state.since = this.now();
    this.state.status = status;
    this.state.reason = failure?.reason ?? null;
    this.state.message = failure?.message ?? null;
    if (changed) this.onChange('status');
  }
}
