import { createLogger } from '@urumi/logger';
import { buildApp } from './app';
import { loadConfig } from './config';
import type { GatewayContext } from './context';
import { createDatabase, createPool, pingDatabase } from './db/client';
import { registerAuthPlugin, registerAuthRoutes } from './modules/auth/routes';
import { bootstrapAdmin } from './modules/auth/users';
import { registerKeyRoutes } from './modules/keys/routes';

// Composition root: real implementations are wired here; tests wire fakes into the same factories.
async function main() {
  const logger = createLogger('gateway');
  const config = loadConfig();
  const pool = createPool();
  pool.on('error', (error) => logger.error({ err: error }, 'idle database connection failed'));

  const ctx: GatewayContext = {
    db: createDatabase(pool),
    logger,
    settings: {
      apiKeyPepper: config.API_KEY_PEPPER,
      cookieSecure: config.PUBLIC_BASE_URL.startsWith('https://'),
      publicBaseUrl: config.PUBLIC_BASE_URL,
    },
    now: () => new Date(),
  };

  await bootstrapAdmin(ctx, config.BOOTSTRAP_ADMIN_EMAIL, config.BOOTSTRAP_ADMIN_PASSWORD);

  const app = await buildApp({
    logger,
    checkDatabase: () => pingDatabase(pool),
    version: { name: 'gateway', version: config.APP_VERSION, commit: config.GIT_SHA },
    register: async (instance) => {
      await registerAuthPlugin(instance, ctx);
      registerAuthRoutes(instance, ctx);
      registerKeyRoutes(instance, ctx);
    },
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
