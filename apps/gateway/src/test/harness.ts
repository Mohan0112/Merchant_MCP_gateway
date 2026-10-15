import { createLogger } from '@urumi/logger';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Writable } from 'node:stream';
import pg from 'pg';
import { buildApp } from '../app';
import type { GatewayContext } from '../context';
import { createDatabase, runMigrations } from '../db/client';
import { registerAuthPlugin, registerAuthRoutes } from '../modules/auth/routes';
import { registerKeyRoutes } from '../modules/keys/routes';

/** Integration tests run against real PostgreSQL when TEST_DATABASE_URL is set; otherwise they skip. */
export const databaseUrl = process.env.TEST_DATABASE_URL;

export const quietLogger = createLogger('test', {
  destination: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
});

export interface Harness {
  app: FastifyInstance;
  ctx: GatewayContext;
  pool: pg.Pool;
  close(): Promise<void>;
}

/** Fresh schema state, the full gateway app, and a clock tests can move. */
export async function createHarness(clock = { now: new Date() }): Promise<Harness> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  await runMigrations(pool, 'drizzle');
  await pool.query(
    'TRUNCATE users, sessions, invitations, api_keys, audit_logs, upstream_servers, upstream_tools, system_settings RESTART IDENTITY CASCADE',
  );
  const ctx: GatewayContext = {
    db: createDatabase(pool),
    logger: quietLogger,
    settings: {
      apiKeyPepper: 'test-pepper-0123456789abcdef0123456789',
      cookieSecure: false,
      publicBaseUrl: 'http://app.test',
    },
    now: () => clock.now,
  };
  const app = await buildApp({
    logger: quietLogger,
    checkDatabase: async () => {},
    version: { name: 'gateway', version: 'test', commit: 'test' },
    register: async (instance) => {
      await registerAuthPlugin(instance, ctx);
      registerAuthRoutes(instance, ctx);
      registerKeyRoutes(instance, ctx);
    },
  });
  return {
    app,
    ctx,
    pool,
    async close() {
      await app.close();
      await pool.end();
    },
  };
}

/** A logged-in browser: keeps the session cookie and sends the anti-CSRF header on writes. */
export class Browser {
  private cookie = '';

  constructor(private readonly app: FastifyInstance) {}

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
