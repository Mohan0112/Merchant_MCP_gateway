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
