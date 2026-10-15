import { describe, expect, it } from 'vitest';
import { formatLocal, resolvePeriod } from './period';

const iso = (d: Date) => d.toISOString();

describe('resolvePeriod in Asia/Kolkata (UTC+05:30, no DST)', () => {
  const tz = 'Asia/Kolkata';
  // 2026-10-15 00:15 IST = 2026-10-14 18:45 UTC: "today" must already be the 15th in India.
  const justAfterMidnight = new Date('2026-10-14T18:45:00Z');

  it('today starts at local midnight even when UTC is still on the previous day', () => {
    const range = resolvePeriod('today', tz, justAfterMidnight);
    expect(iso(range.after)).toBe('2026-10-14T18:30:00.000Z');
    expect(iso(range.before)).toBe('2026-10-15T18:30:00.000Z');
    expect(formatLocal(range.after, tz)).toBe('2026-10-15 00:00');
  });

  it('yesterday is the previous local day', () => {
    const range = resolvePeriod('yesterday', tz, justAfterMidnight);
    expect(iso(range.after)).toBe('2026-10-13T18:30:00.000Z');
    expect(iso(range.before)).toBe('2026-10-14T18:30:00.000Z');
  });

  it('last_7_days covers today and the six days before it', () => {
    const range = resolvePeriod('last_7_days', tz, justAfterMidnight);
    expect(iso(range.after)).toBe('2026-10-08T18:30:00.000Z');
    expect(iso(range.before)).toBe('2026-10-15T18:30:00.000Z');
  });

  it('this_month runs from the 1st to the 1st of the next month, across a year boundary', () => {
    const range = resolvePeriod('this_month', tz, new Date('2026-12-20T10:00:00Z'));
    expect(iso(range.after)).toBe('2026-11-30T18:30:00.000Z');
    expect(iso(range.before)).toBe('2026-12-31T18:30:00.000Z');
  });
});

describe('resolvePeriod across a daylight-saving change (America/New_York)', () => {
  it('today on the day clocks go back is 25 hours long', () => {
    // 2026-11-01: EDT (UTC-4) until 02:00, then EST (UTC-5).
    const range = resolvePeriod('today', 'America/New_York', new Date('2026-11-01T15:00:00Z'));
    expect(iso(range.after)).toBe('2026-11-01T04:00:00.000Z');
    expect(iso(range.before)).toBe('2026-11-02T05:00:00.000Z');
  });
});
