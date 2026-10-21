// Entry point of the `migrate` initContainer: apply pending migrations, then exit.
import { createLogger } from '@ahjin/logger';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, runMigrations } from './client';

const logger = createLogger('gateway-migrate');
const folder =
  process.env.MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), 'migrations');

const pool = createPool();
try {
  const started = Date.now();
  await runMigrations(pool, folder);
  logger.info({ folder, ms: Date.now() - started }, 'migrations applied');
} catch (error) {
  logger.error({ err: error }, 'migrations failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
