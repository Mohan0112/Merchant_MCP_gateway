import { readFileSync } from 'node:fs';
import * as z from 'zod';

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  /** Namespace of the Store resources (the platform's own), from the downward API. */
  NAMESPACE: z.string().min(1),
  /** The gateway's internal API, for registering each store's MCP server. */
  GATEWAY_URL: z.url().default('http://gateway:8080'),
  /** Shared with the gateway (Secret gateway-internal); never leaves the cluster. */
  INTERNAL_TOKEN: z.string().min(32),
  /** JSON of the Helm values every store starts from (global settings, images): the chart's ConfigMap. */
  STORE_VALUES_FILE: z.string().default('/etc/store-operator/values.json'),
  /** The store-instance chart baked into the image. */
  CHART_PATH: z.string().default('/app/charts/store-instance'),
  HELM_BIN: z.string().default('helm'),
  PROVISION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60_000),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  /** Stores provisioned at the same time; the rest wait their turn. */
  MAX_PARALLEL: z.coerce.number().int().min(1).max(10).default(3),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Values every store's Helm release gets; per-store values (name, host) are added on top. */
export interface BaseValues {
  global: {
    domain: string;
    scheme: 'http' | 'https';
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n- ${problems.join('\n- ')}`);
  }
  return parsed.data;
}

export function loadBaseValues(path: string): BaseValues {
  const values = JSON.parse(readFileSync(path, 'utf8')) as BaseValues;
  if (!values.global?.domain) throw new Error(`${path}: global.domain is missing`);
  return values;
}
