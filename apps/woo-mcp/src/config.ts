import * as z from 'zod';

const list = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  /** Bearer token the gateway must present (Secret woo-mcp-auth). */
  WOO_MCP_TOKEN: z.string().min(16),
  /** Comma-separated Host names accepted on /mcp (the chart sets every form of the Service name). */
  MCP_ALLOWED_HOSTS: z.string().min(1).transform(list),
  /** In-cluster WordPress URL; its host must equal the store's URUMI_INTERNAL_HOST (ADR-0002). */
  WOO_BASE_URL: z.url().default('http://wordpress:8080'),
  /** REST key of the mcp-bot shop_manager user (Secret store-woo-api). */
  WOO_CONSUMER_KEY: z.string().startsWith('ck_'),
  WOO_CONSUMER_SECRET: z.string().startsWith('cs_'),
  /** Public storefront URL; links in tool results point here. */
  STORE_PUBLIC_URL: z.url(),
  WOO_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Fail fast: a pod with bad configuration never becomes ready. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid configuration:\n- ${problems.join('\n- ')}`);
  }
  return parsed.data;
}
