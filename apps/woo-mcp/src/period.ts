/**
 * Resolves relative periods ("today", "last_7_days"…) to exact UTC bounds in the store's timezone,
 * so the model never has to do date maths (FR-WM-03). Uses only Intl; no date library.
 */

export const PERIODS = ['today', 'yesterday', 'last_7_days', 'this_month'] as const;
export type Period = (typeof PERIODS)[number];

export interface DateRange {
  /** Inclusive UTC start. */
  after: Date;
  /** Exclusive UTC end. */
  before: Date;
}

interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds (positive east of Greenwich). */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The calendar date `instant` falls on in `timeZone`. */
function localDate(instant: Date, timeZone: string): LocalDate {
  const shifted = new Date(instant.getTime() + offsetMs(instant, timeZone));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** UTC instant of local midnight on the given date (handles DST by re-checking the offset). */
function startOfDay({ year, month, day }: LocalDate, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - offsetMs(new Date(guess), timeZone);
  const second = guess - offsetMs(new Date(first), timeZone);
  return new Date(second);
}

/** Calendar arithmetic on local dates; Date.UTC normalises overflowing days and months. */
function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function resolvePeriod(period: Period, timeZone: string, now: Date = new Date()): DateRange {
  const today = localDate(now, timeZone);
  switch (period) {
    case 'today':
      return {
        after: startOfDay(today, timeZone),
        before: startOfDay(addDays(today, 1), timeZone),
      };
    case 'yesterday':
      return {
        after: startOfDay(addDays(today, -1), timeZone),
        before: startOfDay(today, timeZone),
      };
    case 'last_7_days':
      return {
        after: startOfDay(addDays(today, -6), timeZone),
        before: startOfDay(addDays(today, 1), timeZone),
      };
    case 'this_month': {
      const first = { ...today, day: 1 };
      const nextFirst = {
        year: today.month === 12 ? today.year + 1 : today.year,
        month: (today.month % 12) + 1,
        day: 1,
      };
      return { after: startOfDay(first, timeZone), before: startOfDay(nextFirst, timeZone) };
    }
  }
}

/** Formats an instant as wall-clock time in `timeZone`, e.g. "2026-10-15 00:00". */
export function formatLocal(instant: Date, timeZone: string): string {
  const shifted = new Date(instant.getTime() + offsetMs(instant, timeZone));
  return shifted.toISOString().slice(0, 16).replace('T', ' ');
}
