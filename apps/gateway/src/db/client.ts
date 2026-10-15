import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

/** node-postgres reads PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE from the environment. */
export function createPool(): pg.Pool {
  return new pg.Pool({ max: 10, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30_000 });
}

export function createDatabase(pool: pg.Pool): Database {
  return drizzle(pool, { schema });
}

/** Cheap readiness check: one round trip with a hard timeout. */
export async function pingDatabase(pool: pg.Pool, timeoutMs = 2000): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query({ text: 'select 1', query_timeout: timeoutMs } as pg.QueryConfig);
  } finally {
    client.release();
  }
}

/** Applies pending SQL migrations in order. Already-applied ones are skipped, so re-runs are safe. */
export async function runMigrations(pool: pg.Pool, migrationsFolder: string): Promise<void> {
  await migrate(createDatabase(pool), { migrationsFolder });
}
