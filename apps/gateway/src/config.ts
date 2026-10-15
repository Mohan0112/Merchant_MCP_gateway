import * as z from 'zod';

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
  /** First admin, created only when the users table is empty (Secret gateway-bootstrap-admin). */
  BOOTSTRAP_ADMIN_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12),
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
