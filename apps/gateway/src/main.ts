import { createLogger } from '@ahjin/logger';
import { buildApp } from './app';
import { createGatewayModules, shutdown } from './compose';
import { loadConfig, mcpAllowedHosts, type Config } from './config';
import type { GatewayContext } from './context';
import { createDatabase, createPool, pingDatabase } from './db/client';
import { sdkClientFactory } from './mcp/upstream/sdk-client';
import { bootstrapAdmin } from './modules/auth/users';
import { FallbackProvider, OpenAiCompatibleProvider, type LlmProvider } from './modules/chat/llm';
import { seedUpstreams } from './modules/servers/seed';

/** Groq first, Gemini as fallback; a provider without a key is skipped. */
function createLlmProvider(config: Config): LlmProvider | null {
  const providers: LlmProvider[] = [];
  if (config.GROQ_API_KEY) {
    providers.push(
      new OpenAiCompatibleProvider('groq', config.GROQ_MODEL, {
        baseURL: config.GROQ_BASE_URL,
        apiKey: config.GROQ_API_KEY,
      }),
    );
  }
  if (config.GEMINI_API_KEY) {
    providers.push(
      new OpenAiCompatibleProvider('gemini', config.GEMINI_MODEL, {
        baseURL: config.GEMINI_BASE_URL,
        apiKey: config.GEMINI_API_KEY,
      }),
    );
  }
  return providers.length ? new FallbackProvider(providers) : null;
}

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
      credentialKey: config.CREDENTIAL_KEY,
      cookieSecure: config.PUBLIC_BASE_URL.startsWith('https://'),
      publicBaseUrl: config.PUBLIC_BASE_URL,
    },
    now: () => new Date(),
  };

  await bootstrapAdmin(ctx, config.BOOTSTRAP_ADMIN_EMAIL, config.BOOTSTRAP_ADMIN_PASSWORD);
  await seedUpstreams(ctx, config.SEED_UPSTREAMS, process.env);

  const provider = createLlmProvider(config);
  logger.info({ llm: provider?.name ?? 'none' }, 'chat agent configured');
  const modules = createGatewayModules(ctx, {
    factory: sdkClientFactory,
    provider,
    assistantContext: config.CHAT_CONTEXT,
    allowedHosts: mcpAllowedHosts(config),
    version: config.APP_VERSION,
    mcpUrl: () => `http://127.0.0.1:${config.PORT}/mcp`,
  });

  const app = await buildApp({
    logger,
    checkDatabase: () => pingDatabase(pool),
    version: { name: 'gateway', version: config.APP_VERSION, commit: config.GIT_SHA },
    register: modules.register,
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'shutting down');
      shutdown(app, modules, 10_000)
        .then(() => pool.end())
        .catch((error: unknown) => logger.error({ err: error }, 'error during shutdown'))
        .finally(() => process.exit(0));
    });
  }

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  await modules.start();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
