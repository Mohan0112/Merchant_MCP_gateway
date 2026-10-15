#!/usr/bin/env node
// Creates the Kubernetes Secrets the Helm chart references by name (ADR-008).
//
//   node scripts/secrets.mjs                         # local cluster (context k3d-urumi)
//   node scripts/secrets.mjs --context my-vps        # another cluster
//   node scripts/secrets.mjs --recreate store-db     # delete and regenerate one Secret
//
// - Values you provide come from .env.local (never committed) and are re-applied on every run.
// - Random values are generated only when a Secret doesn't exist yet, so re-running never rotates
//   a password under a running database.
// - Manifests go to kubectl on stdin, so no secret appears in a command line, and values are
//   never printed.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.length ? rest.join('=') : 'true'];
  }),
);
const context = args.context ?? 'k3d-urumi';
const namespace = args.namespace ?? 'urumi';
const envFile = args['env-file'] ?? '.env.local';
const recreate = new Set((args.recreate ?? '').split(',').filter(Boolean));

function readEnvFile(path) {
  if (!existsSync(path))
    throw new Error(`${path} not found. Copy .env.example to ${path} and fill it in.`);
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const env = readEnvFile(envFile);

function required(name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is empty in ${envFile}`);
  return value;
}

const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
const hex = (bytes) => randomBytes(bytes).toString('hex');
const password = () => token(18); // 24 URL-safe characters

const salts = () =>
  Object.fromEntries(
    [
      'auth-key',
      'secure-auth-key',
      'logged-in-key',
      'nonce-key',
      'auth-salt',
      'secure-auth-salt',
      'logged-in-salt',
      'nonce-salt',
    ].map((key) => [key, token(48)]),
  );

/**
 * Every Secret the chart references.
 * - `generate`: called only when the Secret doesn't exist (or is listed in --recreate).
 * - `sync`: values from .env.local, re-applied on every run (user-provided, may change).
 */
const SECRETS = [
  {
    name: 'store-db',
    generate: () => ({ 'root-password': password(), password: password() }),
  },
  {
    name: 'store-wp',
    generate: () => ({
      ...salts(),
      'admin-user': env.WP_ADMIN_USER || 'storeadmin',
      'admin-email': required('WP_ADMIN_EMAIL'),
      'admin-password': env.WP_ADMIN_PASSWORD || password(),
    }),
  },
  {
    // REST key for the mcp-bot WordPress user (ADR-0002); WooCommerce's own key format.
    name: 'store-woo-api',
    generate: () => ({ 'consumer-key': `ck_${hex(20)}`, 'consumer-secret': `cs_${hex(20)}` }),
  },
  { name: 'woo-mcp-auth', generate: () => ({ token: token(32) }) },
  { name: 'fx-mcp-auth', generate: () => ({ 'api-key': token(32) }) },
  { name: 'platform-db', generate: () => ({ password: password() }) },
  {
    name: 'gateway-crypto',
    generate: () => ({
      'api-key-pepper': token(32),
      'credential-key': randomBytes(32).toString('base64'), // AES-256-GCM key for upstream credentials
    }),
  },
  {
    name: 'gateway-bootstrap-admin',
    generate: () => ({
      email: required('ADMIN_EMAIL'),
      password: env.ADMIN_PASSWORD || password(),
    }),
  },
  {
    name: 'llm',
    sync: () => ({
      'groq-api-key': env.GROQ_API_KEY ?? '',
      'gemini-api-key': env.GEMINI_API_KEY ?? '',
    }),
  },
  {
    name: 'github-mcp',
    sync: () => ({
      token: env.GITHUB_MCP_PAT ?? '',
      repo:
        env.GITHUB_USERNAME && env.GITHUB_MCP_DEMO_REPO
          ? `${env.GITHUB_USERNAME}/${env.GITHUB_MCP_DEMO_REPO}`
          : '',
    }),
  },
];

function kubectl(argv, input) {
  return execFileSync('kubectl', ['--context', context, ...argv], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

const exists = (kind, name, ns) =>
  kubectl(['get', kind, name, ...(ns ? ['-n', ns] : []), '--ignore-not-found', '-o', 'name']) !==
  '';

function apply(name, stringData) {
  const manifest = {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
      name,
      namespace,
      labels: {
        'app.kubernetes.io/part-of': 'urumi',
        'app.kubernetes.io/managed-by': 'secrets-script',
      },
    },
    stringData,
  };
  kubectl(['apply', '-f', '-'], JSON.stringify(manifest));
}

if (!exists('namespace', namespace)) {
  kubectl(['create', 'namespace', namespace]);
  console.log(`created namespace ${namespace}`);
}

for (const secret of SECRETS) {
  const keys = (data) => Object.keys(data).join(', ');
  if (secret.sync) {
    const data = secret.sync();
    apply(secret.name, data);
    const empty = Object.entries(data)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    console.log(
      `synced     ${secret.name.padEnd(24)} [${keys(data)}]${empty.length ? `  (empty: ${empty.join(', ')})` : ''}`,
    );
    continue;
  }
  const present = exists('secret', secret.name, namespace);
  if (present && !recreate.has(secret.name)) {
    console.log(`kept       ${secret.name.padEnd(24)} (already exists)`);
    continue;
  }
  if (present) kubectl(['delete', 'secret', secret.name, '-n', namespace]);
  const data = secret.generate();
  apply(secret.name, data);
  console.log(`${present ? 'recreated' : 'created'}  ${secret.name.padEnd(24)} [${keys(data)}]`);
}

console.log(
  `\nSecrets are in namespace "${namespace}" on context "${context}". Run "task logins" to see generated logins.`,
);
