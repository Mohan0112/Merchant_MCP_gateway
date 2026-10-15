import { createLogger } from '@urumi/logger';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createPool, pingDatabase } from './db/client';

// Composition root: real implementations are wired here; tests wire fakes into the same factories.
async function main() {
  const logger = createLogger('gateway');
  const config = loadConfig();
  const pool = createPool();
  pool.on('error', (error) => logger.error({ err: error }, 'idle database connection failed'));

  const app = buildApp({
    logger,
    checkDatabase: () => pingDatabase(pool),
    version: { name: 'gateway', version: config.APP_VERSION, commit: config.GIT_SHA },
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'shutting down');
      app
        .close()
        .then(() => pool.end())
        .catch((error: unknown) => logger.error({ err: error }, 'error during shutdown'))
        .finally(() => process.exit(0));
    });
  }

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
