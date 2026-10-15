import * as z from 'zod';

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  /** Credential the gateway sends in the X-API-Key header. */
  FX_API_KEY: z.string().min(16),
  /** Comma-separated Host names accepted on /mcp (the chart sets every form of the Service name). */
  MCP_ALLOWED_HOSTS: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(',')
        .map((host) => host.trim())
        .filter(Boolean),
    ),
  FX_RATES_URLS: z
    .string()
    .default(
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies,https://latest.currency-api.pages.dev/v1/currencies',
    )
    .transform((value) =>
      value
        .split(',')
        .map((url) => url.trim())
        .filter(Boolean),
    ),
  FX_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
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
