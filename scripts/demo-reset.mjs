#!/usr/bin/env node
// Puts the running system into a clean, known state for a demo (task demo:reset).
//
//   node scripts/demo-reset.mjs                  # local cluster
//   node scripts/demo-reset.mjs --keep-orders --keep-products --keep-audit
//   node scripts/demo-reset.mjs --context=k3d-ahjin-rehearsal --scheme=https --insecure
//
// What it does:
//   1. Store: deletes every order and every product that isn't in the seeded catalogue
//      (docker/wordpress/catalog/products.json).
//   2. Servers: enables every registered server, makes sure fx-mcp runs, and waits until all are
//      connected.
//   3. Users: deletes and re-creates the demo members "User A" (chat in the dashboard) and
//      "User B" (external MCP client) with new passwords, plus leftovers of interrupted DoD runs.
//   4. Audit log: deletes every entry, so the demo's calls are the only ones listed.
// Your own accounts and keys are never touched: like task dod, it works through a temporary admin
// that it deletes at the end. The demo logins are stored in Secret demo-users (task logins).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  clusterTools,
  inviteAndAccept,
  parseOptions,
  Session,
  sqlText,
  temporaryAdmin,
} from './lib/cluster.mjs';

const options = parseOptions();
const { args, app: APP, store: STORE } = options;
const { kubectl, psql, wp, secretValue } = clusterTools(options);
const run = randomBytes(3).toString('hex');
const CATALOG = JSON.parse(
  readFileSync(new URL('../docker/wordpress/catalog/products.json', import.meta.url), 'utf8'),
);
const SAMPLE_SKUS = new Set(CATALOG.products.map((p) => p.sku));
const DEMO_USERS = [
  { label: 'A', name: 'User A', email: args['a-email'] ?? 'user-a@example.com' },
  { label: 'B', name: 'User B', email: args['b-email'] ?? 'user-b@example.com' },
];

const step = (message) => console.log(`\n${message}`);
const done = (message) => console.log(`  ✔ ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Deletes users (and their audit rows; keys and sessions cascade) matching a SQL condition. */
function deleteUsers(where) {
  const ids = psql(`select id from users where ${where};`).split('\n').filter(Boolean);
  if (!ids.length) return 0;
  const list = ids.map(sqlText).join(', ');
  psql(
    `delete from audit_logs where user_id in (${list}); delete from users where id in (${list});`,
  );
  return ids.length;
}

async function resetStore() {
  step('Store');
  const storeAdmin = `--user=${secretValue('store-wp', 'admin-user')}`;
  if (args['keep-orders'] !== 'true') {
    let deleted = 0;
    for (;;) {
      const ids = wp(
        'wc',
        'shop_order',
        'list',
        storeAdmin,
        '--status=any',
        '--per_page=100',
        '--field=id',
      )
        .split(/\s+/)
        .filter(Boolean);
      if (!ids.length) break;
      for (const id of ids) wp('wc', 'shop_order', 'delete', id, '--force=true', storeAdmin);
      deleted += ids.length;
    }
    done(`deleted ${deleted} orders`);
  }
  if (args['keep-products'] !== 'true') {
    const products = JSON.parse(
      wp(
        'wc',
        'product',
        'list',
        storeAdmin,
        '--status=any',
        '--per_page=100',
        '--fields=id,sku',
        '--format=json',
      ),
    );
    const extra = products.filter((p) => !SAMPLE_SKUS.has(p.sku));
    for (const p of extra) wp('wc', 'product', 'delete', String(p.id), '--force=true', storeAdmin);
    const missing = [...SAMPLE_SKUS].filter((sku) => !products.some((p) => p.sku === sku));
    done(
      `deleted ${extra.length} products; ${products.length - extra.length} catalogue products kept`,
    );
    if (missing.length) {
      console.log(
        `  ! samples missing (${missing.join(', ')}): task deploy:local re-runs the store bootstrap`,
      );
    }
  }
}

async function resetServers(admin) {
  step('Servers');
  const replicas = kubectl(['get', 'deployment/fx-mcp', '-o', 'jsonpath={.spec.replicas}']);
  if (replicas !== '1') {
    kubectl(['scale', 'deployment/fx-mcp', '--replicas=1']);
    done('fx-mcp scaled back to 1 replica');
  }
  const { servers } = await admin.ok('GET', '/api/servers');
  for (const server of servers.filter((s) => !s.enabled)) {
    await admin.ok('PATCH', `/api/servers/${server.id}`, { enabled: true });
    done(`enabled ${server.slug}`);
  }
  for (const server of servers.filter((s) => s.status !== 'connected')) {
    await admin.request('POST', `/api/servers/${server.id}/refresh`);
  }
  const deadline = Date.now() + 120_000;
  for (;;) {
    const { servers: now } = await admin.ok('GET', '/api/servers');
    const waiting = now.filter((s) => s.status !== 'connected');
    if (!waiting.length) {
      done(now.map((s) => `${s.slug} connected (${s.toolCount} tools)`).join(', '));
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `not connected after 2 minutes: ${waiting.map((s) => `${s.slug} ${s.status}`).join(', ')}`,
      );
    }
    await sleep(3000);
  }
}

async function resetUsers(admin, adminId) {
  step('Users');
  // Temporary users of interrupted dod-check or demo-reset runs; never this run's own admin.
  const leftovers = deleteUsers(
    `(email like 'dod-%@example.com' or email like 'demo-reset-%@example.com') and id <> ${sqlText(adminId)}`,
  );
  if (leftovers) done(`removed ${leftovers} users left over by interrupted runs`);
  psql(
    `delete from invitations where email like 'dod-%@example.com' or email in (${DEMO_USERS.map((u) => sqlText(u.email)).join(', ')});`,
  );
  const logins = {};
  for (const demo of DEMO_USERS) {
    deleteUsers(`email = ${sqlText(demo.email)}`);
    const password = randomBytes(12).toString('base64url');
    await inviteAndAccept(APP, admin, { email: demo.email, name: demo.name, password });
    logins[demo.label] = { email: demo.email, password };
    done(`${demo.name} <${demo.email}> created as a member`);
  }
  // Kept in a Secret so task logins can show them later; never written to the repository.
  const secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'demo-users', labels: { 'app.kubernetes.io/part-of': 'ahjin' } },
    stringData: {
      'user-a-email': logins.A.email,
      'user-a-password': logins.A.password,
      'user-b-email': logins.B.email,
      'user-b-password': logins.B.password,
    },
  };
  kubectl(['apply', '-f', '-'], JSON.stringify(secret));
  return logins;
}

function resetAudit() {
  step('Audit log');
  if (args['keep-audit'] === 'true') return done('kept (--keep-audit)');
  const count = psql(
    'with gone as (delete from audit_logs returning 1) select count(*) from gone;',
  );
  done(`deleted ${count} entries`);
}

console.log(`Resetting the demo state at ${APP} and ${STORE} (run ${run})`);
const health = await new Session(APP).request('GET', '/api/auth/me');
if (health.status !== 401)
  throw new Error(`the gateway didn't answer as expected (HTTP ${health.status})`);
const temporary = await temporaryAdmin(
  { app: APP, psql },
  `demo-reset-${run}@example.com`,
  'Demo reset',
);
let logins;
try {
  await resetStore();
  await resetServers(temporary.session);
  logins = await resetUsers(temporary.session, temporary.id);
  resetAudit();
} finally {
  deleteUsers(`id = ${sqlText(temporary.id)}`);
}

step('Ready for the demo');
console.log(`  Dashboard  ${APP}   (members: Chat, API keys, Audit log)`);
console.log(`  Storefront ${STORE}/shop/`);
if (process.stdout.isTTY) {
  for (const label of ['A', 'B']) {
    console.log(`  User ${label}     ${logins[label].email}  password: ${logins[label].password}`);
  }
} else {
  console.log('  Logins of users A and B: Secret demo-users (task logins prints them)');
}
