import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WooError } from './port';
import { WooRestClient } from './rest-client';

/** A tiny stand-in for WooCommerce's REST API; each test scripts its responses. */
type Handler = (
  req: http.IncomingMessage,
  url: URL,
  body: string,
) => { status: number; body: unknown; headers?: Record<string, string>; delayMs?: number };
let handler: Handler;
const seen: Array<{ method: string; url: URL; auth?: string; body: string }> = [];
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://wordpress');
      seen.push({ method: req.method ?? '', url, auth: req.headers.authorization, body });
      const reply = handler(req, url, body);
      setTimeout(() => {
        res.writeHead(reply.status, { 'Content-Type': 'application/json', ...reply.headers });
        res.end(JSON.stringify(reply.body));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  seen.length = 0;
});

const client = (timeoutMs = 2000) =>
  new WooRestClient({
    baseUrl,
    publicUrl: 'http://store.127.0.0.1.nip.io',
    consumerKey: 'ck_test',
    consumerSecret: 'cs_test',
    timeoutMs,
    sleep: async () => {},
  });

const product = {
  id: 10,
  name: 'Dell XPS 13',
  sku: 'DEL-XPS13',
  price: '499',
  regular_price: '499',
  status: 'publish',
  stock_status: 'instock',
  stock_quantity: null,
  permalink: 'https://store.127.0.0.1.nip.io/product/dell-xps-13/',
  description: '<p>A sturdy <b>mug</b>.</p>',
  short_description: '',
  categories: [{ name: 'Uncategorized' }],
  date_created: '2026-10-15T16:50:00',
};

describe('WooRestClient', () => {
  it('sends Basic Auth and rebases links onto the public store URL', async () => {
    handler = () => ({
      status: 200,
      body: [product],
      headers: { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' },
    });
    const page = await client().listProducts({ page: 1, per_page: 20, search: 'mug' });

    expect(seen[0]?.auth).toBe(`Basic ${Buffer.from('ck_test:cs_test').toString('base64')}`);
    expect(seen[0]?.url.pathname).toBe('/wp-json/wc/v3/products');
    expect(seen[0]?.url.searchParams.get('search')).toBe('mug');
    expect(page.total).toBe(1);
    expect(page.items[0]?.permalink).toBe('http://store.127.0.0.1.nip.io/product/dell-xps-13/');
  });

  it('sends order windows as GMT with dates_are_gmt=true', async () => {
    handler = () => ({ status: 200, body: [] });
    await client().listOrders({
      after: new Date('2026-10-14T18:30:00Z'),
      before: new Date('2026-10-15T18:30:00Z'),
      page: 1,
      per_page: 20,
    });
    const params = seen[0]!.url.searchParams;
    expect(params.get('after')).toBe('2026-10-14T18:30:00');
    expect(params.get('before')).toBe('2026-10-15T18:30:00');
    expect(params.get('dates_are_gmt')).toBe('true');
  });

  it('filters products by category slug or name, and explains an unknown category', async () => {
    handler = (_req, url) =>
      url.pathname.endsWith('/products/categories')
        ? {
            status: 200,
            body: [
              { id: 7, name: 'Gaming', slug: 'gaming', count: 4 },
              { id: 1, name: 'Uncategorized', slug: 'uncategorized', count: 0 },
            ],
          }
        : { status: 200, body: [product], headers: { 'x-wp-total': '1' } };
    await client().listProducts({
      page: 1,
      per_page: 20,
      category: 'Gaming',
      stock_status: 'instock',
    });
    const products = seen.find((r) => r.url.pathname === '/wp-json/wc/v3/products')!;
    expect(products.url.searchParams.get('category')).toBe('7');
    expect(products.url.searchParams.get('stock_status')).toBe('instock');
    await expect(
      client().listProducts({ page: 1, per_page: 20, category: 'phones' }),
    ).rejects.toMatchObject({
      kind: 'invalid',
      message: "there is no category 'phones'. Categories: gaming",
    });
  });

  it('strips HTML from product descriptions', async () => {
    handler = () => ({ status: 200, body: product });
    expect((await client().getProduct(10)).description).toBe('A sturdy mug .');
  });

  it('classifies 404 as not_found', async () => {
    handler = () => ({
      status: 404,
      body: { code: 'woocommerce_rest_shop_order_invalid_id', message: 'Invalid ID.' },
    });
    await expect(client().getOrder(999)).rejects.toMatchObject({ kind: 'not_found', status: 404 });
  });

  it('retries GETs on 503 and succeeds', async () => {
    let calls = 0;
    handler = () =>
      ++calls < 3 ? { status: 503, body: { message: 'busy' } } : { status: 200, body: product };
    const result = await client().getProduct(10);
    expect(result.id).toBe(10);
    expect(calls).toBe(3);
  });

  it('never retries writes', async () => {
    let calls = 0;
    handler = () => {
      calls++;
      return { status: 503, body: { message: 'busy' } };
    };
    await expect(
      client().createProduct({ name: 'X', regular_price: '1.00', status: 'publish' }),
    ).rejects.toBeInstanceOf(WooError);
    expect(calls).toBe(1);
  });

  it('reports a slow store as unavailable after the timeout', async () => {
    handler = () => ({ status: 200, body: product, delayMs: 300 });
    await expect(client(50).getProduct(10)).rejects.toMatchObject({
      kind: 'unavailable',
      message: 'no response within 0.05s',
    });
  });

  it('passes WooCommerce validation messages through as invalid', async () => {
    handler = () => ({
      status: 400,
      body: { code: 'product_invalid_sku', message: 'Invalid or duplicated SKU.' },
    });
    await expect(
      client().createProduct({
        name: 'Mug',
        regular_price: '499.00',
        status: 'publish',
        sku: 'DEL-XPS13',
      }),
    ).rejects.toMatchObject({ kind: 'invalid', message: 'Invalid or duplicated SKU.' });
  });

  it('updates an order status, reports the previous one and adds a note', async () => {
    let status = 'processing';
    handler = (req, url, body) => {
      if (url.pathname.endsWith('/notes')) return { status: 201, body: { id: 1 } };
      if (req.method === 'PUT') status = (JSON.parse(body) as { status: string }).status;
      return { status: 200, body: { id: 14, status, line_items: [], billing: {}, shipping: {} } };
    };
    const result = await client().updateOrderStatus(14, 'completed', 'Delivered by courier');
    expect(result).toEqual({ id: 14, previous_status: 'processing', status: 'completed' });
    expect(seen.map((s) => s.method)).toEqual(['GET', 'PUT', 'POST']);
  });

  it('reads timezone and currency for store settings', async () => {
    handler = (_req, url) =>
      url.pathname === '/wp-json/'
        ? { status: 200, body: { name: 'Ahjin', timezone_string: 'Asia/Kolkata' } }
        : { status: 200, body: { id: 'woocommerce_currency', value: 'INR' } };
    expect(await client().getStoreSettings()).toEqual({
      name: 'Ahjin',
      store_url: 'http://store.127.0.0.1.nip.io',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
    });
  });
});
