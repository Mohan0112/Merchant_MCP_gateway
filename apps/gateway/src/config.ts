import * as z from 'zod';
import { UpstreamSeedSchema } from './modules/servers/seed';

const csv = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  /** node-postgres reads these directly; listed so a missing one fails at startup, not on first query. */
  PGHOST: z.string().min(1),
  PGPORT: z.coerce.number().int().positive().default(5432),
  PGUSER: z.string().min(1),
  PGPASSWORD: z.string().min(1),
  PGDATABASE: z.string().min(1),
  /** Public URL of the dashboard and gateway, e.g. http://app.127.0.0.1.nip.io */
  PUBLIC_BASE_URL: z.url(),
  /** Server-side secret mixed into API key hashes (Secret gateway-crypto). */
  API_KEY_PEPPER: z.string().min(32),
  /** AES-256-GCM key for upstream credentials at rest: 32 bytes, base64 (Secret gateway-crypto). */
  CREDENTIAL_KEY: z
    .string()
    .transform((value) => Buffer.from(value, 'base64'))
    .refine((key) => key.length === 32, 'must be 32 bytes, base64-encoded'),
  /** First admin, created only when the users table is empty (Secret gateway-bootstrap-admin). */
  BOOTSTRAP_ADMIN_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12),
  /** In-cluster MCP servers registered on first boot: a JSON array (see modules/servers/seed.ts). */
  SEED_UPSTREAMS: z
    .string()
    .default('[]')
    .transform((value, ctx) => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        ctx.issues.push({ code: 'custom', message: 'must be a JSON array', input: value });
        return z.NEVER;
      }
    })
    .pipe(z.array(UpstreamSeedSchema)),
  /** Extra Host names accepted on /mcp (comma-separated); the public host and in-cluster names always are. */
  MCP_ALLOWED_HOSTS: z.string().default('').transform(csv),
  /** Chat agent models, tried in order: Groq first, Gemini as fallback. An empty key skips that provider. */
  GROQ_API_KEY: z.string().default(''),
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),
  GROQ_BASE_URL: z.url().default('https://api.groq.com/openai/v1'),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_BASE_URL: z.url().default('https://generativelanguage.googleapis.com/v1beta/openai/'),
  APP_VERSION: z.string().default('0.1.0'),
  GIT_SHA: z.string().default('dev'),
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

/** Host names /mcp answers to: the public host, the in-cluster Service names, loopback, and extras. */
export function mcpAllowedHosts(
  config: Pick<Config, 'PUBLIC_BASE_URL' | 'MCP_ALLOWED_HOSTS'>,
): string[] {
  const hosts = new Set([
    new URL(config.PUBLIC_BASE_URL).hostname,
    'gateway',
    'gateway.ahjin',
    'gateway.ahjin.svc',
    'gateway.ahjin.svc.cluster.local',
    '127.0.0.1',
    'localhost',
    ...config.MCP_ALLOWED_HOSTS,
  ]);
  return [...hosts];
}
