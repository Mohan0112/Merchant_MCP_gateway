/** Exchange rates for one base currency. Codes are upper-case ISO 4217 (e.g. "INR"). */
export interface RateTable {
  base: string;
  date: string;
  rates: Record<string, number>;
  source: string;
}

/** Where rates come from. Implementations are swappable (live API, static table, test fake). */
export interface RatesSource {
  getRates(base: string): Promise<RateTable>;
}

const ISO_CODE = /^[A-Z]{3}$/;

/**
 * Daily rates from the free, key-less currency-api published on jsDelivr's CDN, with a mirror.
 * Response shape: { "date": "2026-10-14", "inr": { "usd": 0.012, ... } } with lower-case codes.
 */
export class CurrencyApiSource implements RatesSource {
  constructor(
    private readonly urls: string[],
    private readonly timeoutMs = 5000,
  ) {}

  async getRates(base: string): Promise<RateTable> {
    const errors: string[] = [];
    for (const url of this.urls) {
      try {
        const response = await fetch(`${url}/${base.toLowerCase()}.json`, {
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { date?: string } & Record<string, unknown>;
        const raw = body[base.toLowerCase()] as Record<string, number> | undefined;
        if (!raw || typeof body.date !== 'string') throw new Error('unexpected response shape');
        const rates: Record<string, number> = {};
        for (const [code, rate] of Object.entries(raw)) {
          const upper = code.toUpperCase();
          if (ISO_CODE.test(upper) && typeof rate === 'number' && rate > 0) rates[upper] = rate;
        }
        return { base, date: body.date, rates, source: new URL(url).host };
      } catch (error) {
        errors.push(`${new URL(url).host}: ${(error as Error).message}`);
      }
    }
    throw new Error(`all rate sources failed (${errors.join('; ')})`);
  }
}

/** Approximate USD-based rates (mid-October 2026), used only when every live source is unreachable. */
const STATIC_USD_RATES: Record<string, number> = {
  USD: 1,
  INR: 95.0,
  EUR: 0.86,
  GBP: 0.75,
  JPY: 151.4,
  AUD: 1.53,
  CAD: 1.4,
  SGD: 1.3,
  AED: 3.6725,
  CHF: 0.8,
  CNY: 7.12,
};

export class StaticRatesSource implements RatesSource {
  async getRates(base: string): Promise<RateTable> {
    const baseInUsd = STATIC_USD_RATES[base];
    if (!baseInUsd) throw new Error(`no static rate for ${base}`);
    const rates = Object.fromEntries(
      Object.entries(STATIC_USD_RATES).map(([code, usdRate]) => [code, usdRate / baseInUsd]),
    );
    return { base, date: 'static', rates, source: 'static-fallback' };
  }
}

/** Live source first, static table second, with a per-base cache so tools stay fast. */
export class CachedRates implements RatesSource {
  private readonly cache = new Map<string, { table: RateTable; expires: number }>();

  constructor(
    private readonly live: RatesSource,
    private readonly fallback: RatesSource,
    private readonly ttlMs: number,
    private readonly onFallback: (error: Error) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  async getRates(base: string): Promise<RateTable> {
    const hit = this.cache.get(base);
    if (hit && hit.expires > this.now()) return hit.table;
    try {
      const table = await this.live.getRates(base);
      this.cache.set(base, { table, expires: this.now() + this.ttlMs });
      return table;
    } catch (error) {
      this.onFallback(error as Error);
      return this.fallback.getRates(base);
    }
  }
}
