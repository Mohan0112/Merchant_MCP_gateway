// Shared plumbing for the scripts that drive a running cluster (dod-check, demo-reset):
// command-line options, kubectl and psql helpers, a dashboard session and a temporary admin.
import { execFileSync } from 'node:child_process';
import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

/** --key=value and --flag options, plus the cluster and URL settings every script shares. */
export function parseOptions(argv = process.argv.slice(2)) {
  const args = Object.fromEntries(
    argv.map((arg) => {
      const [key, ...rest] = arg.replace(/^--/, '').split('=');
      return [key, rest.length ? rest.join('=') : 'true'];
    }),
  );
  const domain = args.domain ?? '127.0.0.1.nip.io';
  const scheme = args.scheme ?? 'http';
  if (args.insecure === 'true') {
    // Self-signed certificates (the production rehearsal): skip TLS verification in this process only.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    console.log('--insecure: TLS certificates are not verified in this run');
  }
  return {
    args,
    context: args.context ?? 'k3d-urumi',
    namespace: args.namespace ?? 'urumi',
    app: `${scheme}://app.${domain}`,
    store: `${scheme}://store.${domain}`,
  };
}

/** kubectl, psql and WP-CLI against one namespace of one cluster. */
export function clusterTools({ context, namespace }) {
  const kubectl = (argv, input) =>
    execFileSync('kubectl', ['--context', context, '-n', namespace, ...argv], {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  const psql = (sql) =>
    kubectl(
      [
        'exec',
        '-i',
        'postgres-0',
        '--',
        'psql',
        '-U',
        'urumi',
        '-d',
        'urumi',
        '-v',
        'ON_ERROR_STOP=1',
        '-At',
      ],
      sql,
    );
  const wp = (...argv) => kubectl(['exec', 'deploy/wordpress', '--', 'wp', ...argv]);
  const secretValue = (name, key) =>
    Buffer.from(
      kubectl(['get', 'secret', name, '-o', `jsonpath={.data.${key}}`]),
      'base64',
    ).toString();
  return { kubectl, psql, wp, secretValue };
}

export const sqlText = (value) => `'${String(value).replaceAll("'", "''")}'`;

/** Same format as the gateway's hashPassword (scrypt N=2^15, r=8, p=3). */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, {
    N: 2 ** 15,
    r: 8,
    p: 3,
    maxmem: 64 * 1024 * 1024,
  });
  return ['scrypt', 2 ** 15, 8, 3, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** A browser session against the dashboard API: cookie jar and the anti-CSRF header on writes. */
export class Session {
  cookie = '';
  constructor(app) {
    this.app = app;
  }
  async request(method, path, body) {
    const res = await fetch(`${this.app}${path}`, {
      method,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(method !== 'GET' ? { 'x-requested-with': 'fetch' } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  }
  async ok(method, path, body) {
    const res = await this.request(method, path, body);
    if (res.status >= 400)
      throw new Error(`${method} ${path} → HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    return res.json;
  }
}

/**
 * Inserts a temporary admin straight into PostgreSQL and signs it in, so scripts never need (or
 * touch) a real account. Returns the signed-in session and the user id to delete afterwards.
 */
export async function temporaryAdmin({ app, psql }, email, name) {
  const password = randomBytes(18).toString('base64url');
  const hash = await hashPassword(password);
  const id = psql(
    `insert into users (email, name, password_hash, role) values (${sqlText(email)}, ${sqlText(name)}, ${sqlText(hash)}, 'admin') returning id;`,
  ).split('\n')[0];
  const session = new Session(app);
  await session.ok('POST', '/api/auth/login', { email, password });
  return { session, id };
}

/** Invites someone through the API and accepts the invitation as them; returns their session. */
export async function inviteAndAccept(app, admin, { email, name, password, role = 'member' }) {
  const { invitation } = await admin.ok('POST', '/api/invitations', { email, role });
  const token = new URL(invitation.link).pathname.split('/').pop();
  const session = new Session(app);
  const { user } = await session.ok('POST', `/api/invitations/accept/${token}`, { name, password });
  return { session, user };
}
