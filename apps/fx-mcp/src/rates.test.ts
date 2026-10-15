import { describe, expect, it, vi } from 'vitest';
import { CachedRates, StaticRatesSource, type RatesSource, type RateTable } from './rates';

const table = (source: string): RateTable => ({
  base: 'INR',
  date: '2026-10-14',
  rates: { USD: 0.012, EUR: 0.0103 },
  source,
});

describe('CachedRates', () => {
  it('serves from the live source and caches the result', async () => {
    const live: RatesSource = { getRates: vi.fn(async () => table('live')) };
    const rates = new CachedRates(live, new StaticRatesSource(), 60_000);
    await rates.getRates('INR');
    const second = await rates.getRates('INR');
    expect(second.source).toBe('live');
    expect(live.getRates).toHaveBeenCalledTimes(1);
  });

  it('refreshes after the TTL expires', async () => {
    let now = 0;
    const live: RatesSource = { getRates: vi.fn(async () => table('live')) };
    const rates = new CachedRates(live, new StaticRatesSource(), 1000, undefined, () => now);
    await rates.getRates('INR');
    now = 1001;
    await rates.getRates('INR');
    expect(live.getRates).toHaveBeenCalledTimes(2);
  });

  it('falls back to the static table when the live source fails', async () => {
    const onFallback = vi.fn();
    const live: RatesSource = {
      getRates: async () => {
        throw new Error('timeout');
      },
    };
    const rates = new CachedRates(live, new StaticRatesSource(), 60_000, onFallback);
    const result = await rates.getRates('INR');
    expect(result.source).toBe('static-fallback');
    expect(result.rates.USD).toBeCloseTo(1 / 95.0, 6);
    expect(onFallback).toHaveBeenCalledOnce();
  });
});
