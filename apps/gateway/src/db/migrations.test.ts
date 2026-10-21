import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from './client';

// Runs against a real PostgreSQL when TEST_DATABASE_URL is set (CI service container, or locally:
// docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:17.11-alpine).
const url = process.env.TEST_DATABASE_URL;
const pool = url ? new pg.Pool({ connectionString: url }) : undefined;

afterAll(async () => {
  await pool?.end();
});

describe.skipIf(!url)('database migrations', () => {
  it('apply on an empty database and are safe to run again', async () => {
    await runMigrations(pool!, 'drizzle');
    await runMigrations(pool!, 'drizzle');

    const { rows } = await pool!.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'api_keys',
      'audit_logs',
      'invitations',
      'sessions',
      'system_settings',
      'tool_policies',
      'upstream_servers',
      'upstream_tools',
      'users',
    ]);
  });

  it('enforces case-insensitive unique emails', async () => {
    await pool!.query(`delete from users`);
    await pool!.query(
      `insert into users (email, name, password_hash) values ('Asha@Example.com', 'A', 'x')`,
    );
    await expect(
      pool!.query(
        `insert into users (email, name, password_hash) values ('asha@example.com', 'B', 'y')`,
      ),
    ).rejects.toThrow(/users_email_lower_unique/);
    await pool!.query(`delete from users`);
  });
});
