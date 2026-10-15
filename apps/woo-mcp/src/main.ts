import { closeOnSignals, createMcpHttpServer } from '@urumi/mcp-kit';
import { createLogger } from '@urumi/logger';
import { loadConfig } from './config';
import { buildTools, cachedSettings } from './tools';
import { WooRestClient } from './woo/rest-client';

const NAME = 'woo-mcp';
const VERSION = '0.1.0';

async function main() {
  const logger = createLogger(NAME);
  const config = loadConfig();

  const woo = new WooRestClient({
    baseUrl: config.WOO_BASE_URL,
    publicUrl: config.STORE_PUBLIC_URL,
    consumerKey: config.WOO_CONSUMER_KEY,
    consumerSecret: config.WOO_CONSUMER_SECRET,
    timeoutMs: config.WOO_TIMEOUT_MS,
    logger,
  });
  const settings = cachedSettings(woo);

  const server = createMcpHttpServer({
    name: NAME,
    version: VERSION,
    tools: buildTools({ woo, settings }),
    credential: { type: 'bearer', token: config.WOO_MCP_TOKEN },
    allowedHosts: config.MCP_ALLOWED_HOSTS,
    // server_info never fails the call: a store outage is reported as data instead.
    info: async () => {
      try {
        const s = await settings();
        return {
          store_name: s.name,
          store_url: s.store_url,
          timezone: s.timezone,
          currency: s.currency,
        };
      } catch {
        return { store_url: config.STORE_PUBLIC_URL, store: 'unreachable' };
      }
    },
    logger,
  });

  closeOnSignals(server, logger);
  const address = await server.listen(config.PORT);
  logger.info({ address, store: config.WOO_BASE_URL }, `${NAME} ${VERSION} listening`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
