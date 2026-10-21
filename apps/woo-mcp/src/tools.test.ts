import { ToolError, type ToolHandler } from '@ahjin/mcp-kit';
import { describe, expect, it } from 'vitest';
import { buildTools } from './tools';
import {
  WooError,
  type CreateProductInput,
  type ListOrdersQuery,
  type WooCommercePort,
} from './woo/port';

/** In-memory WooCommerce that records what the tools asked for. */
function fakeWoo() {
  const calls: { listOrders?: ListOrdersQuery; createProduct?: CreateProductInput } = {};
  const woo: WooCommercePort = {
    listProducts: async () => ({ items: [], total: 0, total_pages: 0 }),
    getProduct: async (id) => {
      throw new WooError('not_found', `no product ${id}`, 404);
    },
    createProduct: async (input) => {
      calls.createProduct = input;
      return {
        id: 42,
        name: input.name,
        sku: input.sku ?? '',
        price: input.regular_price,
        regular_price: input.regular_price,
        status: input.status,
        stock_status: 'instock',
        permalink: 'http://store.test/product/x/',
      };
    },
    listOrders: async (query) => {
      calls.listOrders = query;
      return { items: [], total: 0, total_pages: 0 };
    },
    getOrder: async (id) => {
      throw new WooError('not_found', `no order ${id}`, 404);
    },
    updateOrderStatus: async () => {
      throw new WooError('unavailable', 'no response within 10s');
    },
    getStoreSettings: async () => ({
      name: 'S',
      store_url: 'http://store.test',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
    }),
  };
  return { woo, calls };
}

function setup(now = new Date('2026-10-15T06:00:00Z')) {
  const { woo, calls } = fakeWoo();
  const tools = Object.fromEntries(
    buildTools({ woo, settings: woo.getStoreSettings, now: () => now }).map((t) => [t.name, t]),
  ) as Record<string, ToolHandler>;
  const run = (name: string, input: unknown) => {
    const tool = tools[name]!;
    return tool.execute(tool.inputSchema.parse(input) as never) as Promise<Record<string, unknown>>;
  };
  return { run, calls, tools };
}

describe('woo-mcp tools', () => {
  it('exposes the five required tools plus get_product', () => {
    expect(Object.keys(setup().tools).sort()).toEqual([
      'create_product',
      'get_order',
      'get_product',
      'list_orders',
      'list_products',
      'update_order_status',
    ]);
  });

  it('list_orders period=today asks the store for the local day in the store timezone', async () => {
    const { run, calls } = setup();
    const result = await run('list_orders', { period: 'today' });
    expect(calls.listOrders?.after?.toISOString()).toBe('2026-10-14T18:30:00.000Z');
    expect(calls.listOrders?.before?.toISOString()).toBe('2026-10-15T18:30:00.000Z');
    expect(result.window).toEqual({ from: '2026-10-15 00:00', to: '2026-10-16 00:00' });
    expect(result.timezone).toBe('Asia/Kolkata');
  });

  it('list_orders treats a date-only bound as a whole local day', async () => {
    const { run, calls } = setup();
    await run('list_orders', { after: '2026-10-01', before: '2026-10-01' });
    expect(calls.listOrders?.after?.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(calls.listOrders?.before?.toISOString()).toBe('2026-10-01T18:30:00.000Z');
  });

  it('rejects mixing period with explicit bounds', async () => {
    const { run } = setup();
    await expect(run('list_orders', { period: 'today', after: '2026-10-01' })).rejects.toThrow(
      'Use either period or after/before, not both.',
    );
  });

  it('create_product accepts a numeric price and publishes by default', async () => {
    const { run, calls } = setup();
    const result = (await run('create_product', {
      name: 'Ahjin Laptop Sleeve',
      regular_price: 499,
    })) as {
      product: { id: number };
    };
    expect(calls.createProduct).toMatchObject({
      name: 'Ahjin Laptop Sleeve',
      regular_price: '499.00',
      status: 'publish',
    });
    expect(result.product.id).toBe(42);
  });

  it('explains a missing order as a tool error', async () => {
    const { run } = setup();
    await expect(run('get_order', { id: 999 })).rejects.toEqual(
      new ToolError('Order 999 not found.'),
    );
  });

  it('explains an unavailable store', async () => {
    const { run } = setup();
    await expect(run('update_order_status', { id: 14, status: 'completed' })).rejects.toThrow(
      /The store is unavailable right now \(no response within 10s\)/,
    );
  });

  it('only accepts known order statuses', () => {
    const { tools } = setup();
    expect(() =>
      tools.update_order_status!.inputSchema.parse({ id: 1, status: 'shipped' }),
    ).toThrow();
  });
});
