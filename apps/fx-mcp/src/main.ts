import { closeOnSignals, createMcpHttpServer } from '@urumi/mcp-kit';
import { createLogger } from '@urumi/logger';
import { loadConfig } from './config';
import { CachedRates, CurrencyApiSource, StaticRatesSource } from './rates';
import { buildTools } from './tools';

const NAME = 'fx-mcp';
const VERSION = '0.1.0';

async function main() {
  const logger = createLogger(NAME);
  const config = loadConfig();

  const rates = new CachedRates(
    new CurrencyApiSource(config.FX_RATES_URLS),
    new StaticRatesSource(),
    config.FX_CACHE_TTL_SECONDS * 1000,
    (error) =>
      logger.warn({ err: error }, 'live rates unavailable, using the static fallback table'),
  );

  const server = createMcpHttpServer({
    name: NAME,
    version: VERSION,
    tools: buildTools(rates),
    credential: { type: 'header', header: 'X-API-Key', value: config.FX_API_KEY },
    allowedHosts: config.MCP_ALLOWED_HOSTS,
    info: () => ({
      rate_sources: config.FX_RATES_URLS.map((url) => new URL(url).host),
      cache_ttl_seconds: config.FX_CACHE_TTL_SECONDS,
    }),
    logger,
  });

  closeOnSignals(server, logger);
  const address = await server.listen(config.PORT);
  logger.info({ address }, `${NAME} ${VERSION} listening`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
