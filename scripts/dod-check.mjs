#!/usr/bin/env node
// End-to-end check of the brief's definition of done, against a running cluster.
//
//   node scripts/dod-check.mjs                 # local cluster (k3d-urumi, *.127.0.0.1.nip.io)
//   node scripts/dod-check.mjs --skip-chat     # without the steps that need the LLM
//   node scripts/dod-check.mjs --keep          # keep the temporary users, audit rows and store data
//   node scripts/dod-check.mjs --domain=example.com --scheme=https --context=my-vps
//   node scripts/dod-check.mjs --scheme=https --insecure   # self-signed certificates (rehearsal)
//
// It never touches your own accounts: a temporary admin is inserted directly into PostgreSQL, and
// users A and B are invited through the API like real members. Then it walks the flow:
// store checkout, chat agent as A, external MCP client as B, key revocation, disabling a server,
// a dead upstream, and the audit log. At the end it removes everything it created (users, their
// keys and audit rows, test products and orders), so "orders today" in your demo stays clean.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { clusterTools, parseOptions, Session, sqlText, temporaryAdmin } from './lib/cluster.mjs';

const options = parseOptions();
const { args, app: APP, store: STORE } = options;
const skipChat = args['skip-chat'] === 'true';
const keep = args.keep === 'true';
const run = randomBytes(3).toString('hex');

// The MCP SDK client is a dependency of the gateway package; load it from there.
const gatewayRequire = createRequire(new URL('../apps/gateway/package.json', import.meta.url));
const { Client, StreamableHTTPClientTransport } = await import(
  pathToFileURL(gatewayRequire.resolve('@modelcontextprotocol/client')).href
);

// ---------- reporting ----------

const results = [];
function report(ok, step, detail = '') {
  results.push({ ok, step });
  console.log(`${ok ? '  ✔' : '  ✘'} ${step}${detail ? ` — ${detail}` : ''}`);
}
async function check(step, fn) {
  try {
    const detail = await fn();
    report(true, step, typeof detail === 'string' ? detail : '');
    return true;
  } catch (error) {
    report(false, step, error.message);
    return false;
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const section = (title) => console.log(`\n${title}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(fn, timeoutMs, everyMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(everyMs);
    }
  }
}

// ---------- cluster and HTTP helpers ----------

const { kubectl, psql, wp, secretValue } = clusterTools(options);

/** A dashboard session that can also run one chat turn. */
class ChatSession extends Session {
  constructor() {
    super(APP);
  }
  /** One chat turn; returns the server-sent events. */
  async chat(content) {
    const res = await fetch(`${APP}/api/chat`, {
      method: 'POST',
      headers: {
        cookie: this.cookie,
        'x-requested-with': 'fetch',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content }] }),
    });
    assert(res.ok, `chat HTTP ${res.status}`);
    const text = await res.text();
    return text
      .split('\n\n')
      .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
      .filter(Boolean)
      .map((line) => JSON.parse(line.slice(6)));
  }
}

/** Checkout through the WooCommerce Store API, as the storefront does (cash on delivery). */
async function placeOrder(productId) {
  const cart = await fetch(`${STORE}/wp-json/wc/store/v1/cart`);
  const headers = {
    'content-type': 'application/json',
    'cart-token': cart.headers.get('cart-token'),
    nonce: cart.headers.get('nonce'),
  };
  const added = await fetch(`${STORE}/wp-json/wc/store/v1/cart/add-item`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: productId, quantity: 1 }),
  });
  assert(added.ok, `add to cart HTTP ${added.status}: ${(await added.text()).slice(0, 200)}`);
  const address = {
    first_name: 'Dod',
    last_name: `Check ${run}`,
    address_1: '1 MG Road',
    city: 'Bengaluru',
    state: 'KA',
    postcode: '560001',
    country: 'IN',
    email: `dod-${run}@example.com`,
    phone: '9999999999',
  };
  const checkout = await fetch(`${STORE}/wp-json/wc/store/v1/checkout`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      billing_address: address,
      shipping_address: address,
      payment_method: 'cod',
    }),
  });
  const body = await checkout.json();
  assert(checkout.ok, `checkout HTTP ${checkout.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body.order_id;
}

async function mcpClient(key) {
  const client = new Client(
    { name: 'dod-check', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${APP}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}
const resultText = (result) => (result.content ?? []).map((c) => c.text ?? '').join('\n');

// ---------- the run ----------

const created = { userIds: [], productIds: [], orderIds: [] };
let admin;
const userA = new ChatSession();
const userB = new ChatSession();
let fxId;
let fxScaledDown = false;
let fxDisabled = false;

async function setUp() {
  section('Setup');
  await check('gateway answers through the ingress', async () => {
    const res = await new Session(APP).request('GET', '/api/auth/me');
    assert(res.status === 401, `expected 401 without a session, got ${res.status}`);
  });
  const temporary = await temporaryAdmin(
    { app: APP, psql },
    `dod-admin-${run}@example.com`,
    'DoD check admin',
  );
  admin = temporary.session;
  created.userIds.push(temporary.id);

  for (const [label, session] of [
    ['A', userA],
    ['B', userB],
  ]) {
    const email = `dod-${label.toLowerCase()}-${run}@example.com`;
    const password = randomBytes(18).toString('base64url');
    const { invitation } = await admin.ok('POST', '/api/invitations', { email });
    const token = new URL(invitation.link).pathname.split('/').pop();
    const { user } = await session.ok('POST', `/api/invitations/accept/${token}`, {
      name: `User ${label}`,
      password,
    });
    created.userIds.push(user.id);
    session.userId = user.id;
    session.email = email;
  }
  report(true, 'temporary admin, user A and user B (invited and accepted)');
}

async function upstreams() {
  section('Upstream servers');
  const { servers } = await admin.ok('GET', '/api/servers');
  fxId = servers.find((s) => s.slug === 'fx')?.id;
  const connected = servers.filter((s) => s.status === 'connected');
  await check('WooCommerce MCP server is registered and connected', async () => {
    const woo = servers.find((s) => s.slug === 'woo');
    assert(woo, 'no server with slug "woo"');
    assert(woo.status === 'connected', `status ${woo.status} ${woo.statusMessage ?? ''}`);
    return `${woo.toolCount} tools`;
  });
  await check('at least three upstream servers connected', async () => {
    assert(connected.length >= 3, `only ${connected.map((s) => s.slug).join(', ')}`);
    return connected.map((s) => `${s.slug} (${s.toolCount})`).join(', ');
  });
  await check('members never see upstream URLs or credentials', async () => {
    const { servers: seen } = await userA.ok('GET', '/api/servers');
    assert(
      seen.every((s) => s.url === null && s.authHeaderName === null),
      'a member saw a URL',
    );
    assert(
      !JSON.stringify(seen).includes(secretValue('woo-mcp-auth', 'token')),
      'credential leaked',
    );
  });
}

async function store() {
  section('Store');
  let productId;
  await check('storefront is up', async () => {
    const res = await fetch(`${STORE}/`);
    assert(res.ok, `HTTP ${res.status}`);
    const products = await (await fetch(`${STORE}/wp-json/wc/store/v1/products?per_page=1`)).json();
    productId = products[0]?.id;
    assert(productId, 'no products in the store');
  });
  await check('checkout with cash on delivery creates an order', async () => {
    const orderId = await placeOrder(productId);
    created.orderIds.push(orderId);
    created.storeOrderId = orderId;
    return `order #${orderId}`;
  });
  await check('the order is in WooCommerce (admin data, read over REST)', async () => {
    const status = wp(
      'wc',
      'shop_order',
      'get',
      String(created.storeOrderId),
      '--field=status',
      `--user=${secretValue('store-wp', 'admin-user')}`,
    );
    assert(['processing', 'pending', 'on-hold'].includes(status), `status ${status}`);
    return `status ${status}`;
  });
}

async function chatAgent() {
  section('Chat agent, as user A');
  if (skipChat) return report(true, 'skipped (--skip-chat)');
  const productName = `DoD Mug ${run}`;
  await check('agent creates a product through woo__create_product', async () => {
    let events = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      events = await userA.chat(
        `Create a product named "${productName}" with a regular price of 349.`,
      );
      if (
        events.some((e) => e.type === 'tool.completed' && e.name === 'woo__create_product' && e.ok)
      )
        break;
    }
    const used = events.filter((e) => e.type === 'tool.started').map((e) => e.name);
    assert(
      used.includes('woo__create_product'),
      `tools used: ${used.join(', ') || 'none'}; ${JSON.stringify(events.at(-2) ?? {}).slice(0, 200)}`,
    );
    return `tools: ${used.join(', ')}`;
  });
  await check('the product appears on the storefront', async () => {
    const found = await eventually(async () => {
      const list = await (
        await fetch(
          `${STORE}/wp-json/wc/store/v1/products?search=${encodeURIComponent(productName)}`,
        )
      ).json();
      const product = list.find((p) => p.name === productName);
      assert(product, 'not found yet');
      return product;
    }, 20_000);
    created.productIds.push(found.id);
    created.chatProductId = found.id;
    const page = await fetch(found.permalink);
    assert(page.ok, `product page HTTP ${page.status}`);
    return found.permalink;
  });
  await check('an order for it is placed on the storefront', async () => {
    const orderId = await placeOrder(created.chatProductId);
    created.orderIds.push(orderId);
    created.chatOrderId = orderId;
    return `order #${orderId}`;
  });
  await check('agent answers "what orders came in today" with that order', async () => {
    let events = [];
    let answer = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      events = await userA.chat('What orders came in today? List their order numbers.');
      answer = events.find((e) => e.type === 'message')?.text ?? '';
      if (answer.includes(String(created.chatOrderId))) break;
    }
    const used = events.filter((e) => e.type === 'tool.started').map((e) => e.name);
    assert(
      used.some((n) => n.startsWith('woo__')),
      `no woo tool used (${used.join(', ')})`,
    );
    assert(
      answer.includes(String(created.chatOrderId)),
      `answer doesn't mention #${created.chatOrderId}: ${answer.slice(0, 200)}`,
    );
    return `tools: ${used.join(', ')}`;
  });
}

async function externalClient() {
  section('External MCP client, as user B');
  const { key } = await userB.ok('POST', '/api/api-keys', { name: 'DoD MCP client' });
  userB.key = key;
  const client = await mcpClient(key.key);
  try {
    await check('sees the tools of every enabled server', async () => {
      const { tools } = await client.listTools();
      const servers = [...new Set(tools.map((t) => t.name.split('__')[0]))];
      assert(servers.includes('woo') && servers.includes('fx'), `servers: ${servers.join(', ')}`);
      return `${tools.length} tools from ${servers.join(', ')}`;
    });
    await check('orders question: woo__list_orders for today', async () => {
      const result = await client.callTool({
        name: 'woo__list_orders',
        arguments: { period: 'today' },
      });
      assert(!result.isError, resultText(result).slice(0, 200));
      const text = resultText(result);
      for (const id of created.orderIds) assert(text.includes(`"id":${id}`), `order ${id} missing`);
      return `found orders ${created.orderIds.map((id) => `#${id}`).join(', ')}`;
    });
    await check('one request that needs two servers (order total converted to USD)', async () => {
      const order = await client.callTool({
        name: 'woo__get_order',
        arguments: { id: created.storeOrderId },
      });
      assert(!order.isError, resultText(order).slice(0, 200));
      const { total, currency } = order.structuredContent ?? JSON.parse(resultText(order));
      const fx = await client.callTool({
        name: 'fx__convert_currency',
        arguments: { amount: Number(total), from: currency, to: 'USD' },
      });
      assert(!fx.isError, resultText(fx).slice(0, 200));
      return `${total} ${currency} → ${resultText(fx).slice(0, 120)}`;
    });
  } finally {
    await client.close().catch(() => {});
  }
}

async function teamAndControl() {
  section('Team and control');
  await check("revoking user B's key rejects their next call", async () => {
    const client = await mcpClient(userB.key.key);
    await userB.ok('DELETE', `/api/api-keys/${userB.key.id}`);
    const outcome = await client.listTools().then(
      () => 'accepted',
      (error) => error.message,
    );
    await client.close().catch(() => {});
    assert(outcome !== 'accepted', 'the revoked key still works');
    return outcome.slice(0, 80);
  });

  const { key } = await userB.ok('POST', '/api/api-keys', { name: 'DoD second key' });
  const client = await mcpClient(key.key);
  try {
    await check(
      'disabling a server hides its tools from MCP clients and the chat agent',
      async () => {
        await admin.ok('PATCH', `/api/servers/${fxId}`, { enabled: false });
        fxDisabled = true;
        const { tools } = await client.listTools();
        assert(!tools.some((t) => t.name.startsWith('fx__')), 'fx tools still listed');
        const call = await client.callTool({
          name: 'fx__convert_currency',
          arguments: { amount: 1, from: 'USD', to: 'INR' },
        });
        assert(
          call.isError && /disabled/.test(resultText(call)),
          `direct call: ${resultText(call).slice(0, 120)}`,
        );
        let chatNote = 'chat check skipped';
        if (!skipChat) {
          const events = await userA.chat('Convert 100 USD to INR using your tools.');
          const used = events.filter((e) => e.type === 'tool.started').map((e) => e.name);
          assert(!used.some((n) => n.startsWith('fx__')), 'the chat agent still called an fx tool');
          chatNote = `chat agent used: ${used.join(', ') || 'no tools'}`;
        }
        await admin.ok('PATCH', `/api/servers/${fxId}`, { enabled: true });
        fxDisabled = false;
        await eventually(async () => {
          const again = await client.listTools();
          assert(
            again.tools.some((t) => t.name.startsWith('fx__')),
            'fx tools not back yet',
          );
        }, 30_000);
        return `${chatNote}; re-enabled`;
      },
    );

    await check('a dead upstream shows as unreachable while the others keep working', async () => {
      kubectl(['scale', 'deployment/fx-mcp', '--replicas=0']);
      fxScaledDown = true;
      kubectl([
        'wait',
        '--for=delete',
        'pod',
        '-l',
        'app.kubernetes.io/name=fx-mcp',
        '--timeout=60s',
      ]);
      // A call to it fails fast with a clear error, and triggers an immediate health check.
      const dead = await client.callTool({
        name: 'fx__convert_currency',
        arguments: { amount: 1, from: 'USD', to: 'INR' },
      });
      const deadText = resultText(dead);
      const server = await eventually(async () => {
        const { server: fx } = await admin.ok('GET', `/api/servers/${fxId}`);
        assert(fx.status === 'unreachable', `status ${fx.status}`);
        return fx;
      }, 60_000);
      const woo = await client.callTool({ name: 'woo__list_products', arguments: { per_page: 1 } });
      assert(!woo.isError, `woo failed while fx was down: ${resultText(woo).slice(0, 120)}`);
      kubectl(['scale', 'deployment/fx-mcp', '--replicas=1']);
      fxScaledDown = false;
      await eventually(async () => {
        const { server: fx } = await admin.ok('GET', `/api/servers/${fxId}`);
        assert(fx.status === 'connected', `status ${fx.status}`);
      }, 120_000);
      return `dashboard: ${server.statusReason} (${server.statusMessage}); call: "${deadText.slice(0, 70)}"; back to connected`;
    });
  } finally {
    await client.close().catch(() => {});
  }

  await check('every call is in the audit log under the right user', async () => {
    const forA = (await admin.ok('GET', `/api/audit-logs?userId=${userA.userId}&limit=200`))
      .entries;
    const forB = (await admin.ok('GET', `/api/audit-logs?userId=${userB.userId}&limit=200`))
      .entries;
    if (!skipChat) {
      assert(
        forA.some(
          (e) =>
            e.channel === 'chat_agent' &&
            e.toolName === 'create_product' &&
            e.outcome === 'success',
        ),
        'no create_product by A',
      );
      assert(
        forA.every((e) => e.channel === 'chat_agent'),
        'A has non-chat entries',
      );
    }
    const outcomes = new Set(forB.map((e) => e.outcome));
    for (const expected of ['success', 'denied_auth', 'rejected_disabled']) {
      assert(
        outcomes.has(expected),
        `B has no "${expected}" entry (has ${[...outcomes].join(', ')})`,
      );
    }
    // The call to the dead server fails either fast (refused) or after its timeout (a reused
    // keep-alive connection to the vanished pod IP); both are recorded.
    assert(
      outcomes.has('upstream_unreachable') || outcomes.has('timeout'),
      'the call to the dead server is not in the log',
    );
    assert(
      forB.every((e) => e.userEmail === userB.email),
      'an entry of B is attributed to someone else',
    );
    const memberView = (await userB.ok('GET', '/api/audit-logs?limit=200')).entries;
    assert(
      memberView.every((e) => e.userId === userB.userId),
      'a member sees other users in the audit log',
    );
    return `A: ${forA.length} entries, B: ${forB.length} entries (${[...outcomes].join(', ')})`;
  });
}

async function cleanUp() {
  section('Clean-up');
  if (fxScaledDown) kubectl(['scale', 'deployment/fx-mcp', '--replicas=1']);
  if (fxDisabled) await admin.request('PATCH', `/api/servers/${fxId}`, { enabled: true });
  if (keep) {
    console.log('  --keep: leaving the temporary users, audit rows and store data in place');
    return;
  }
  const storeAdmin = secretValue('store-wp', 'admin-user');
  for (const id of created.orderIds) {
    try {
      wp('wc', 'shop_order', 'delete', String(id), '--force=true', `--user=${storeAdmin}`);
    } catch (error) {
      console.log(`  could not delete order ${id}: ${error.message.split('\n')[0]}`);
    }
  }
  for (const id of created.productIds) {
    try {
      wp('wc', 'product', 'delete', String(id), '--force=true', `--user=${storeAdmin}`);
    } catch (error) {
      console.log(`  could not delete product ${id}: ${error.message.split('\n')[0]}`);
    }
  }
  if (created.userIds.length) {
    const ids = created.userIds.map(sqlText).join(', ');
    psql(
      `delete from audit_logs where user_id in (${ids}); delete from invitations where email like 'dod-%-${run}@example.com'; delete from users where id in (${ids});`,
    );
  }
  console.log(
    `  removed ${created.userIds.length} users, ${created.orderIds.length} orders, ${created.productIds.length} products`,
  );
}

console.log(`Definition-of-done check against ${APP} and ${STORE} (run ${run})`);
try {
  await setUp();
  await upstreams();
  await store();
  await chatAgent();
  await externalClient();
  await teamAndControl();
} catch (error) {
  report(false, 'unexpected failure', error.stack ?? error.message);
} finally {
  await cleanUp().catch((error) => console.log(`  clean-up failed: ${error.message}`));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
