/**
 * What woo-mcp needs from WooCommerce, independent of how it's reached. The REST adapter
 * implements it for real; tests use an in-memory fake. Output shapes are deliberately compact and
 * keep personal data out of list views (FR-WM-07).
 */

export interface ProductSummary {
  id: number;
  name: string;
  sku: string;
  price: string;
  regular_price: string;
  status: string;
  stock_status: string;
  permalink: string;
}

export interface ProductDetail extends ProductSummary {
  description: string;
  short_description: string;
  categories: string[];
  stock_quantity: number | null;
  date_created: string;
}

export interface OrderSummary {
  id: number;
  number: string;
  status: string;
  total: string;
  currency: string;
  /** Store-local time, as WooCommerce reports it. */
  date_created: string;
  date_created_gmt: string;
  customer_name: string;
  item_count: number;
  items: Array<{ name: string; quantity: number }>;
}

export interface Address {
  name: string;
  company: string;
  address: string;
  city: string;
  state: string;
  postcode: string;
  country: string;
  email?: string;
  phone?: string;
}

export interface OrderDetail extends OrderSummary {
  payment_method: string;
  payment_method_title: string;
  customer_note: string;
  billing: Address;
  shipping: Address;
  line_items: Array<{ name: string; sku: string; quantity: number; total: string }>;
}

export interface StoreSettings {
  name: string;
  store_url: string;
  timezone: string;
  currency: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  total_pages: number;
}

export type ProductStatus = 'publish' | 'draft' | 'pending' | 'private' | 'any';

export interface ListProductsQuery {
  search?: string;
  sku?: string;
  status?: ProductStatus;
  page: number;
  per_page: number;
}

export interface CreateProductInput {
  name: string;
  regular_price: string;
  description?: string;
  short_description?: string;
  sku?: string;
  status: 'publish' | 'draft';
  stock_quantity?: number;
}

export const ORDER_STATUSES = [
  'pending',
  'processing',
  'on-hold',
  'completed',
  'cancelled',
  'refunded',
  'failed',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface ListOrdersQuery {
  /** UTC bounds (WooCommerce receives them with dates_are_gmt=true). */
  after?: Date;
  before?: Date;
  status?: OrderStatus;
  page: number;
  per_page: number;
}

export interface WooCommercePort {
  listProducts(query: ListProductsQuery): Promise<Page<ProductSummary>>;
  getProduct(id: number): Promise<ProductDetail>;
  createProduct(input: CreateProductInput): Promise<ProductSummary>;
  listOrders(query: ListOrdersQuery): Promise<Page<OrderSummary>>;
  getOrder(id: number): Promise<OrderDetail>;
  updateOrderStatus(
    id: number,
    status: OrderStatus,
    note?: string,
  ): Promise<{ id: number; previous_status: string; status: string }>;
  getStoreSettings(): Promise<StoreSettings>;
}

/** A failure talking to WooCommerce, classified so tools can explain it. */
export class WooError extends Error {
  override name = 'WooError';
  constructor(
    readonly kind: 'not_found' | 'invalid' | 'auth' | 'unavailable',
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
