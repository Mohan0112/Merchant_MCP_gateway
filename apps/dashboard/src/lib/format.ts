const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "3 minutes ago", "in 2 days"; falls back to the date for anything older than a month. */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
  if (abs < 30 * 86_400) return relative.format(Math.round(seconds / 86_400), 'day');
  return new Date(iso).toLocaleDateString();
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** The part of an exposed tool name after "<server>__". */
export function toolOnly(exposedName: string): string {
  const index = exposedName.indexOf('__');
  return index > 0 ? exposedName.slice(index + 2) : exposedName;
}
