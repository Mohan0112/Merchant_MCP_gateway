import { defineTool, ToolError, type ToolHandler } from '@ahjin/mcp-kit';
import * as z from 'zod';
import { formatLocal, PERIODS, resolvePeriod, type DateRange } from './period';
import { ORDER_STATUSES, WooError, type StoreSettings, type WooCommercePort } from './woo/port';

/** Turns a classified store failure into a message the caller (and the model) can act on. */
function explain(error: unknown, what: string): never {
  if (error instanceof WooError) {
    switch (error.kind) {
      case 'not_found':
        throw new ToolError(`${what} not found.`);
      case 'invalid':
        throw new ToolError(`The store rejected the request: ${error.message}`);
      case 'auth':
        throw new ToolError(
          "The store rejected woo-mcp's credentials. An admin needs to check the store-woo-api Secret.",
        );
      case 'unavailable':
        throw new ToolError(
          `The store is unavailable right now (${error.message}). Try again shortly.`,
        );
    }
  }
  throw error;
}

const Id = z.number().int().positive();
const PageSchema = {
  page: z.number().int().positive().default(1),
  per_page: z.number().int().min(1).max(50).default(20),
};
const Price = z
  .union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d{1,2})?$/)])
  .transform((value) => (typeof value === 'number' ? value.toFixed(2) : value))
  .describe('Regular price in the store currency, e.g. 499 or "499.00"');
/** YYYY-MM-DD (a whole local day in the store timezone) or a full ISO 8601 timestamp. */
const DateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}([T ].+)?$/, 'Use YYYY-MM-DD or an ISO 8601 timestamp');

const ProductSummary = z.object({
  id: z.number(),
  name: z.string(),
  sku: z.string(),
  price: z.string(),
  regular_price: z.string(),
  status: z.string(),
  stock_status: z.string(),
  permalink: z.string(),
});
const OrderSummary = z.object({
  id: z.number(),
  number: z.string(),
  status: z.string(),
  total: z.string(),
  currency: z.string(),
  date_created: z.string(),
  date_created_gmt: z.string(),
  customer_name: z.string(),
  item_count: z.number(),
  items: z.array(z.object({ name: z.string(), quantity: z.number() })),
});

export interface ToolDependencies {
  woo: WooCommercePort;
  settings: () => Promise<StoreSettings>;
  now?: () => Date;
}

export function buildTools({
  woo,
  settings,
  now = () => new Date(),
}: ToolDependencies): ToolHandler[] {
  const timezone = async () => {
    try {
      return (await settings()).timezone;
    } catch (error) {
      explain(error, 'Store settings');
    }
  };

  /** A date-only bound means a whole local day in the store timezone. */
  const toBound = (value: string, tz: string, edge: 'start' | 'end'): Date => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const day = resolvePeriod('today', tz, new Date(`${value}T12:00:00Z`));
      return edge === 'start' ? day.after : day.before;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new ToolError(`'${value}' is not a valid date.`);
    return parsed;
  };

  const listProducts = defineTool({
    name: 'list_products',
    title: 'List products',
    description:
      'List store products, newest first. Filter by search text, SKU or status. Returns id, name, SKU, price, status, stock status and storefront link.',
    inputSchema: z.object({
      search: z
        .string()
        .min(1)
        .optional()
        .describe('Text to search in product names and descriptions'),
      sku: z.string().min(1).optional(),
      status: z.enum(['publish', 'draft', 'pending', 'private', 'any']).default('any'),
      ...PageSchema,
    }),
    outputSchema: z.object({
      total: z.number(),
      total_pages: z.number(),
      page: z.number(),
      products: z.array(ProductSummary),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    execute: async (input) => {
      try {
        const page = await woo.listProducts(input);
        return {
          total: page.total,
          total_pages: page.total_pages,
          page: input.page,
          products: page.items,
        };
      } catch (error) {
        explain(error, 'Products');
      }
    },
  });

  const getProduct = defineTool({
    name: 'get_product',
    title: 'Get product',
    description: 'Get one product by id, including description, categories and stock.',
    inputSchema: z.object({ id: Id }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    execute: async ({ id }) => {
      try {
        return { ...(await woo.getProduct(id)) };
      } catch (error) {
        explain(error, `Product ${id}`);
      }
    },
  });

  const createProduct = defineTool({
    name: 'create_product',
    title: 'Create product',
    description:
      'Create a product in the store. It is published on the storefront immediately unless status is "draft". Returns the new product with its storefront link.',
    inputSchema: z.object({
      name: z.string().min(1).max(200),
      regular_price: Price,
      description: z.string().max(5000).optional(),
      short_description: z.string().max(1000).optional(),
      sku: z.string().min(1).max(64).optional().describe('Optional unique stock-keeping unit'),
      status: z.enum(['publish', 'draft']).default('publish'),
      stock_quantity: z.number().int().nonnegative().optional(),
    }),
    outputSchema: z.object({ product: ProductSummary }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    execute: async (input) => {
      try {
        return { product: await woo.createProduct(input) };
      } catch (error) {
        explain(error, 'Product');
      }
    },
  });

  const listOrders = defineTool({
    name: 'list_orders',
    title: 'List orders',
    description:
      'List store orders, newest first. Use period="today" for orders placed today; periods are computed in the store timezone. Alternatively give after/before (YYYY-MM-DD or ISO 8601). List results omit addresses and contact details; use get_order for those.',
    inputSchema: z.object({
      period: z.enum(PERIODS).optional(),
      after: DateInput.optional().describe(
        'Inclusive start; a date means the whole day in store time',
      ),
      before: DateInput.optional().describe(
        'Exclusive end; a date means up to the end of that day',
      ),
      status: z.enum(ORDER_STATUSES).optional(),
      ...PageSchema,
    }),
    outputSchema: z.object({
      timezone: z.string(),
      window: z.object({ from: z.string(), to: z.string() }).nullable(),
      total: z.number(),
      total_pages: z.number(),
      page: z.number(),
      orders: z.array(OrderSummary),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    execute: async (input) => {
      if (input.period && (input.after || input.before)) {
        throw new ToolError('Use either period or after/before, not both.');
      }
      const tz = await timezone();
      let range: Partial<DateRange> = {};
      if (input.period) range = resolvePeriod(input.period, tz, now());
      else {
        if (input.after) range.after = toBound(input.after, tz, 'start');
        if (input.before) range.before = toBound(input.before, tz, 'end');
      }
      try {
        const page = await woo.listOrders({
          after: range.after,
          before: range.before,
          status: input.status,
          page: input.page,
          per_page: input.per_page,
        });
        return {
          timezone: tz,
          window:
            range.after || range.before
              ? {
                  from: range.after ? formatLocal(range.after, tz) : 'beginning',
                  to: range.before ? formatLocal(range.before, tz) : 'now',
                }
              : null,
          total: page.total,
          total_pages: page.total_pages,
          page: input.page,
          orders: page.items,
        };
      } catch (error) {
        explain(error, 'Orders');
      }
    },
  });

  const getOrder = defineTool({
    name: 'get_order',
    title: 'Get order',
    description:
      'Get one order by id, including line items, totals, payment method and billing details.',
    inputSchema: z.object({ id: Id }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    execute: async ({ id }) => {
      try {
        return { ...(await woo.getOrder(id)) };
      } catch (error) {
        explain(error, `Order ${id}`);
      }
    },
  });

  const updateOrderStatus = defineTool({
    name: 'update_order_status',
    title: 'Update order status',
    description: `Change an order's status (${ORDER_STATUSES.join(', ')}), optionally adding a private note. Returns the previous and new status.`,
    inputSchema: z.object({
      id: Id,
      status: z.enum(ORDER_STATUSES),
      note: z.string().max(1000).optional().describe('Private order note for store staff'),
    }),
    outputSchema: z.object({ id: z.number(), previous_status: z.string(), status: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    execute: async ({ id, status, note }) => {
      try {
        return await woo.updateOrderStatus(id, status, note);
      } catch (error) {
        explain(error, `Order ${id}`);
      }
    },
  });

  return [
    listProducts,
    getProduct,
    createProduct,
    listOrders,
    getOrder,
    updateOrderStatus,
  ] as ToolHandler[];
}

/** Store settings change rarely; cache them so every list_orders call doesn't re-fetch them. */
export function cachedSettings(
  woo: WooCommercePort,
  ttlMs = 10 * 60_000,
): () => Promise<StoreSettings> {
  let cached: { value: StoreSettings; expires: number } | undefined;
  return async () => {
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = await woo.getStoreSettings();
    cached = { value, expires: Date.now() + ttlMs };
    return value;
  };
}
