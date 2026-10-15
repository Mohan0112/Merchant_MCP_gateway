import { createLogger } from '@urumi/logger';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import pg from 'pg';
import { buildApp } from '../app';
import { createGatewayModules, shutdown, type GatewayModules } from '../compose';
import type { GatewayContext } from '../context';
import { createDatabase, runMigrations } from '../db/client';
import type { UpstreamClientFactory } from '../mcp/upstream/client';
import type { ConnectionOptions } from '../mcp/upstream/connection';
import { sdkClientFactory } from '../mcp/upstream/sdk-client';
import type { LlmProvider } from '../modules/chat/llm';

/** Integration tests run against real PostgreSQL when TEST_DATABASE_URL is set; otherwise they skip. */
export const databaseUrl = process.env.TEST_DATABASE_URL;

export const quietLogger = createLogger('test', {
  destination: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
});

/** Fast timings so tests see status changes in milliseconds, not seconds. */
export const FAST_CONNECTION: ConnectionOptions = {
  connectTimeoutMs: 1000,
  listTimeoutMs: 1000,
  healthIntervalMs: 100,
  healthFailureThreshold: 2,
  callFailureThreshold: 3,
  initialBackoffMs: 50,
  maxBackoffMs: 200,
};

export interface Harness {
  app: FastifyInstance;
  ctx: GatewayContext;
  modules: GatewayModules;
  pool: pg.Pool;
  /** Starts listening on a random loopback port (needed by the chat agent) and returns the base URL. */
  listen(): Promise<string>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  clock?: { now: Date };
  factory?: UpstreamClientFactory;
  provider?: LlmProvider | null;
}

/** Fresh schema state, the full gateway app with its real module wiring, and a clock tests can move. */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = options.clock ?? { now: new Date() };
  const pool = new pg.Pool({ connectionString: databaseUrl });
  await runMigrations(pool, 'drizzle');
  await pool.query(
    'TRUNCATE users, sessions, invitations, api_keys, audit_logs, upstream_servers, upstream_tools, system_settings RESTART IDENTITY CASCADE',
  );
  const ctx: GatewayContext = {
    db: createDatabase(pool),
    logger: quietLogger,
    settings: {
      apiKeyPepper: randomBytes(32).toString('base64url'),
      credentialKey: randomBytes(32),
      cookieSecure: false,
      publicBaseUrl: 'http://app.test',
    },
    now: () => clock.now,
  };
  let baseUrl = '';
  const modules = createGatewayModules(ctx, {
    factory: options.factory ?? sdkClientFactory,
    connection: FAST_CONNECTION,
    provider: options.provider ?? null,
    allowedHosts: ['localhost', '127.0.0.1'],
    version: 'test',
    mcpUrl: () => `${baseUrl}/mcp`,
    closeGraceMs: 200,
  });
  const app = await buildApp({
    logger: quietLogger,
    checkDatabase: async () => {},
    version: { name: 'gateway', version: 'test', commit: 'test' },
    register: modules.register,
  });
  await modules.start();
  return {
    app,
    ctx,
    modules,
    pool,
    async listen() {
      baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
      return baseUrl;
    },
    async close() {
      await shutdown(app, modules, 500);
      await pool.end();
    },
  };
}

/** A logged-in browser: keeps the session cookie and sends the anti-CSRF header on writes. */
export class Browser {
  private cookie = '';

  constructor(private readonly app: FastifyInstance) {}

  /** The session cookie, for requests made over real HTTP instead of inject. */
  get cookieHeader(): string {
    return this.cookie;
  }

  async request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ): Promise<LightMyRequestResponse> {
    const res = await this.app.inject({
      method,
      url,
      payload: payload as never,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(method !== 'GET' ? { 'x-requested-with': 'fetch' } : {}),
      },
    });
    const setCookie = res.headers['set-cookie'];
    const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (value) this.cookie = value.split(';')[0]!;
    return res;
  }

  async login(email: string, password: string) {
    return this.request('POST', '/api/auth/login', { email, password });
  }
}

/** Polls until the check passes; status changes in the gateway are asynchronous. */
export async function eventually<T>(check: () => Promise<T> | T, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}
