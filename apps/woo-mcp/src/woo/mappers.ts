import type { Address, OrderDetail, OrderSummary, ProductDetail, ProductSummary } from './port';

/** Subset of the WooCommerce REST v3 shapes woo-mcp reads. */
export interface WooProduct {
  id: number;
  name: string;
  sku: string;
  price: string;
  regular_price: string;
  status: string;
  stock_status: string;
  stock_quantity: number | null;
  permalink: string;
  description: string;
  short_description: string;
  categories?: Array<{ name: string }>;
  date_created: string;
}

interface WooAddress {
  first_name: string;
  last_name: string;
  company: string;
  address_1: string;
  address_2: string;
  city: string;
  state: string;
  postcode: string;
  country: string;
  email?: string;
  phone?: string;
}

export interface WooOrder {
  id: number;
  number: string;
  status: string;
  total: string;
  currency: string;
  date_created: string;
  date_created_gmt: string;
  payment_method: string;
  payment_method_title: string;
  customer_note: string;
  billing: WooAddress;
  shipping: WooAddress;
  line_items: Array<{ name: string; sku: string; quantity: number; total: string }>;
}

/**
 * Store URLs come back with the scheme and host WordPress saw (https on the internal path, because
 * of the internal-HTTPS mu-plugin). Rebase them onto the public store URL users can open.
 */
export function toPublicUrl(url: string, publicBase: string): string {
  try {
    const parsed = new URL(url);
    return new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, publicBase).toString();
  } catch {
    return url;
  }
}

/** Strips HTML WooCommerce stores in descriptions, so the model gets plain text. */
const plainText = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function toProductSummary(p: WooProduct, publicBase: string): ProductSummary {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku,
    price: p.price,
    regular_price: p.regular_price,
    status: p.status,
    stock_status: p.stock_status,
    permalink: toPublicUrl(p.permalink, publicBase),
  };
}

export function toProductDetail(p: WooProduct, publicBase: string): ProductDetail {
  return {
    ...toProductSummary(p, publicBase),
    description: plainText(p.description),
    short_description: plainText(p.short_description),
    categories: (p.categories ?? []).map((c) => c.name),
    stock_quantity: p.stock_quantity,
    date_created: p.date_created,
  };
}

const fullName = (a: WooAddress) => `${a.first_name} ${a.last_name}`.trim();

export function toOrderSummary(o: WooOrder): OrderSummary {
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    total: o.total,
    currency: o.currency,
    date_created: o.date_created,
    date_created_gmt: o.date_created_gmt,
    customer_name: fullName(o.billing) || 'Guest',
    item_count: o.line_items.reduce((sum, item) => sum + item.quantity, 0),
    items: o.line_items.map((item) => ({ name: item.name, quantity: item.quantity })),
  };
}

function toAddress(a: WooAddress, withContact: boolean): Address {
  return {
    name: fullName(a),
    company: a.company,
    address: [a.address_1, a.address_2].filter(Boolean).join(', '),
    city: a.city,
    state: a.state,
    postcode: a.postcode,
    country: a.country,
    ...(withContact ? { email: a.email ?? '', phone: a.phone ?? '' } : {}),
  };
}

export function toOrderDetail(o: WooOrder): OrderDetail {
  return {
    ...toOrderSummary(o),
    payment_method: o.payment_method,
    payment_method_title: o.payment_method_title,
    customer_note: o.customer_note,
    billing: toAddress(o.billing, true),
    shipping: toAddress(o.shipping, false),
    line_items: o.line_items.map(({ name, sku, quantity, total }) => ({
      name,
      sku,
      quantity,
      total,
    })),
  };
}
