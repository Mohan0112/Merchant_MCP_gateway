import type { Logger } from '@ahjin/logger';
import {
  toOrderDetail,
  toOrderSummary,
  toProductDetail,
  toProductSummary,
  type WooOrder,
  type WooProduct,
} from './mappers';
import {
  WooError,
  type CreateProductInput,
  type ListOrdersQuery,
  type ListProductsQuery,
  type OrderStatus,
  type StoreSettings,
  type WooCommercePort,
} from './port';

export interface WooRestClientOptions {
  /** In-cluster store URL, e.g. http://wordpress:8080 (the internal host enables Basic Auth, ADR-0002). */
  baseUrl: string;
  /** Public store URL, used to rewrite links in responses. */
  publicUrl: string;
  consumerKey: string;
  consumerSecret: string;
  timeoutMs?: number;
  /** Extra attempts for GET requests only; writes are never retried. */
  getRetries?: number;
  logger?: Pick<Logger, 'warn' | 'error'>;
  sleep?: (ms: number) => Promise<void>;
}

type Query = Record<string, string | number | undefined>;

/** WooCommerce expects GMT datetimes without a zone suffix when dates_are_gmt=true. */
const wooDate = (date: Date) => date.toISOString().slice(0, 19);

export class WooRestClient implements WooCommercePort {
  private readonly authorization: string;
  private readonly timeoutMs: number;
  private readonly getRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: WooRestClientOptions) {
    this.authorization = `Basic ${Buffer.from(`${options.consumerKey}:${options.consumerSecret}`).toString('base64')}`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.getRetries = options.getRetries ?? 2;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async listProducts(query: ListProductsQuery) {
    const { data, headers } = await this.request<WooProduct[]>('GET', '/wc/v3/products', {
      query: {
        search: query.search,
        sku: query.sku,
        status: query.status,
        page: query.page,
        per_page: query.per_page,
      },
    });
    return {
      items: data.map((p) => toProductSummary(p, this.options.publicUrl)),
      ...totals(headers, data.length),
    };
  }

  async getProduct(id: number) {
    const { data } = await this.request<WooProduct>('GET', `/wc/v3/products/${id}`);
    return toProductDetail(data, this.options.publicUrl);
  }

  async createProduct(input: CreateProductInput) {
    const { stock_quantity, ...rest } = input;
    const body = {
      ...rest,
      ...(stock_quantity !== undefined ? { manage_stock: true, stock_quantity } : {}),
    };
    const { data } = await this.request<WooProduct>('POST', '/wc/v3/products', { body });
    return toProductSummary(data, this.options.publicUrl);
  }

  async listOrders(query: ListOrdersQuery) {
    const hasWindow = query.after || query.before;
    const { data, headers } = await this.request<WooOrder[]>('GET', '/wc/v3/orders', {
      query: {
        status: query.status,
        page: query.page,
        per_page: query.per_page,
        orderby: 'date',
        order: 'desc',
        after: query.after ? wooDate(query.after) : undefined,
        before: query.before ? wooDate(query.before) : undefined,
        dates_are_gmt: hasWindow ? 'true' : undefined,
      },
    });
    return { items: data.map(toOrderSummary), ...totals(headers, data.length) };
  }

  async getOrder(id: number) {
    const { data } = await this.request<WooOrder>('GET', `/wc/v3/orders/${id}`);
    return toOrderDetail(data);
  }

  async updateOrderStatus(id: number, status: OrderStatus, note?: string) {
    const { data: before } = await this.request<WooOrder>('GET', `/wc/v3/orders/${id}`);
    const { data: after } = await this.request<WooOrder>('PUT', `/wc/v3/orders/${id}`, {
      body: { status },
    });
    if (note) {
      await this.request('POST', `/wc/v3/orders/${id}/notes`, {
        body: { note, customer_note: false },
      });
    }
    return { id, previous_status: before.status, status: after.status };
  }

  async getStoreSettings(): Promise<StoreSettings> {
    const [{ data: site }, { data: currency }] = await Promise.all([
      this.request<{ name?: string; timezone_string?: string }>('GET', '/'),
      this.request<{ value?: string }>('GET', '/wc/v3/settings/general/woocommerce_currency'),
    ]);
    return {
      name: site.name ?? 'Store',
      store_url: this.options.publicUrl,
      timezone: site.timezone_string || 'UTC',
      currency: currency.value ?? 'INR',
    };
  }

  /** One REST call under /wp-json with timeout, GET retries and error classification. */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    { query, body }: { query?: Query; body?: unknown } = {},
  ): Promise<{ data: T; headers: Headers }> {
    const url = new URL(`/wp-json${path}`, this.options.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    const attempts = method === 'GET' ? 1 + this.getRetries : 1;

    for (let attempt = 1; ; attempt++) {
      let failure: WooError;
      try {
        const response = await fetch(url, {
          method,
          headers: {
            Authorization: this.authorization,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.ok) return { data: (await response.json()) as T, headers: response.headers };
        failure = await classify(response);
      } catch (error) {
        const timedOut = (error as Error).name === 'TimeoutError';
        failure = new WooError(
          'unavailable',
          timedOut
            ? `no response within ${this.timeoutMs / 1000}s`
            : `cannot reach the store (${(error as Error).message})`,
        );
      }

      if (failure.kind === 'auth') {
        this.options.logger?.error(
          { status: failure.status, path },
          'store rejected the woo-mcp REST credentials',
        );
      }
      if (failure.kind !== 'unavailable' || attempt >= attempts) throw failure;
      this.options.logger?.warn(
        { path, attempt, reason: failure.message },
        'store call failed, retrying',
      );
      await this.sleep(200 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100));
    }
  }
}

function totals(headers: Headers, count: number) {
  return {
    total: Number(headers.get('x-wp-total') ?? count),
    total_pages: Number(headers.get('x-wp-totalpages') ?? 1),
  };
}

async function classify(response: Response): Promise<WooError> {
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { message?: string };
    if (body.message) message = body.message.replace(/<[^>]*>/g, '');
  } catch {
    // non-JSON error body; keep the status text
  }
  const { status } = response;
  if (status === 404) return new WooError('not_found', message, status);
  if (status === 401 || status === 403) return new WooError('auth', message, status);
  if (status >= 500 || status === 429) return new WooError('unavailable', message, status);
  return new WooError('invalid', message, status);
}
