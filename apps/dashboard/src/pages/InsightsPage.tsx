import type { Insights } from '@ahjin/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useIsAdmin } from '../auth';
import { ErrorNote, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { api } from '../lib/api';
import { duration } from '../lib/format';

const RANGES = [
  { hours: 6, label: 'Last 6 hours' },
  { hours: 24, label: 'Last 24 hours' },
  { hours: 168, label: 'Last 7 days' },
] as const;

/** Stack order bottom → top; colors are the validated --viz-* roles in styles.css. */
const SERIES = [
  { key: 'ok', label: 'Answered', color: 'var(--viz-ok)' },
  { key: 'refused', label: 'Refused by the gateway', color: 'var(--viz-refused)' },
  { key: 'errors', label: 'Failed upstream', color: 'var(--viz-errors)' },
] as const;
type SeriesKey = (typeof SERIES)[number]['key'];
type Bucket = { at: string; end: string } & Record<SeriesKey, number>;

const compact = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`
      : String(n);
const percent = (part: number, whole: number) =>
  whole ? `${((part / whole) * 100).toFixed(part / whole < 0.1 ? 1 : 0)}%` : '–';
const hourLabel = (iso: string, withDay: boolean) =>
  new Date(iso).toLocaleString(undefined, {
    ...(withDay ? { weekday: 'short' } : {}),
    hour: '2-digit',
    minute: '2-digit',
  });

/** Clean axis ticks: 0 and up to four round steps covering the max. */
function ticks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}

/** Hourly buckets, grouped into 6-hour ones for a week so columns stay readable. */
function buckets(timeline: Insights['timeline'], hours: number): Bucket[] {
  const size = hours > 48 ? 6 : 1;
  const result: Bucket[] = [];
  for (let i = 0; i < timeline.length; i += size) {
    const group = timeline.slice(i, i + size);
    const last = group.at(-1)!;
    result.push({
      at: group[0]!.at,
      end: new Date(new Date(last.at).getTime() + 3_600_000).toISOString(),
      ok: group.reduce((n, b) => n + b.ok, 0),
      refused: group.reduce((n, b) => n + b.refused, 0),
      errors: group.reduce((n, b) => n + b.errors, 0),
    });
  }
  return result;
}

function Tooltip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <div className="viz-tooltip" style={{ left: x, top: y }} role="status">
      {children}
    </div>
  );
}

function CallsChart({ data, hours }: { data: Insights['timeline']; hours: number }) {
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const [asTable, setAsTable] = useState(false);
  const rows = buckets(data, hours);
  const total = (b: Bucket) => b.ok + b.refused + b.errors;
  const axis = ticks(Math.max(0, ...rows.map(total)));
  const top = axis.at(-1)!;
  // viewBox units ≈ CSS pixels at a typical card width, so 11-unit text stays ~11-13 px.
  const W = 960;
  const H = 170;
  const top0 = 10; // room above the highest tick label
  const left = 36;
  const plot = W - left - 28;
  const slot = plot / Math.max(rows.length, 1);
  const bar = Math.min(24, slot * 0.7);
  const y = (v: number) => top0 + H - (v / top) * H;
  const labelEvery = Math.ceil(rows.length / 8);
  const withDay = hours > 24;

  return (
    <figure className="card viz">
      <div className="spread">
        <figcaption>
          <strong>Tool calls over time</strong>
          <div className="muted small">
            Per {hours > 48 ? '6 hours' : 'hour'}, by how each call ended
          </div>
        </figcaption>
        <button className="btn small" onClick={() => setAsTable((t) => !t)}>
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>
      <ul className="viz-legend">
        {SERIES.map((s) => (
          <li key={s.key}>
            <span className="viz-swatch" style={{ background: s.color }} />
            {s.label}
          </li>
        ))}
      </ul>
      {asTable ? (
        <div className="table-wrap">
          <table className="numeric">
            <thead>
              <tr>
                <th>From</th>
                {SERIES.map((s) => (
                  <th key={s.key}>{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.at}>
                  <td>{hourLabel(b.at, true)}</td>
                  {SERIES.map((s) => (
                    <td key={s.key}>{b[s.key]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="viz-plot" onPointerLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${top0 + H + 24}`} role="img" aria-label="Tool calls over time">
            {axis.map((t) => (
              <g key={t}>
                <line
                  x1={left}
                  x2={left + plot}
                  y1={y(t)}
                  y2={y(t)}
                  className={t === 0 ? 'viz-baseline' : 'viz-grid'}
                />
                <text x={left - 6} y={y(t) + 4} className="viz-tick" textAnchor="end">
                  {compact(t)}
                </text>
              </g>
            ))}
            {rows.map((b, i) => {
              const cx = left + i * slot + slot / 2;
              let base = 0;
              const segments = SERIES.filter((s) => b[s.key] > 0);
              return (
                <g key={b.at}>
                  {segments.map((s, k) => {
                    const from = y(base);
                    base += b[s.key];
                    const to = y(base);
                    // 2px surface gap between stacked segments; the top one gets the rounded end.
                    const height = Math.max(from - to - (k > 0 ? 2 : 0), 1);
                    const isTop = k === segments.length - 1;
                    return (
                      <path
                        key={s.key}
                        fill={s.color}
                        d={
                          isTop && height > 4
                            ? `M${cx - bar / 2},${from - (k > 0 ? 2 : 0)} v${-(height - 4)} q0,-4 4,-4 h${bar - 8} q4,0 4,4 v${height - 4} z`
                            : `M${cx - bar / 2},${from - (k > 0 ? 2 : 0)} v${-height} h${bar} v${height} z`
                        }
                        opacity={hover && hover.index !== i ? 0.55 : 1}
                      />
                    );
                  })}
                  {i % labelEvery === 0 ? (
                    <text x={cx} y={top0 + H + 16} className="viz-tick" textAnchor="middle">
                      {hourLabel(b.at, withDay)}
                    </text>
                  ) : null}
                  {/* The whole column is the hit target, not just the painted pixels. */}
                  <rect
                    x={left + i * slot}
                    y={top0}
                    width={slot}
                    height={H}
                    fill="transparent"
                    tabIndex={0}
                    aria-label={`${hourLabel(b.at, true)}: ${total(b)} calls`}
                    onPointerMove={(e) => {
                      const box = (
                        e.currentTarget.ownerSVGElement!.parentElement as HTMLElement
                      ).getBoundingClientRect();
                      setHover({ index: i, x: e.clientX - box.left, y: e.clientY - box.top });
                    }}
                    onFocus={(e) => {
                      const box = (
                        e.currentTarget.ownerSVGElement!.parentElement as HTMLElement
                      ).getBoundingClientRect();
                      const mark = e.currentTarget.getBoundingClientRect();
                      setHover({ index: i, x: mark.left - box.left + mark.width / 2, y: 24 });
                    }}
                    onBlur={() => setHover(null)}
                  />
                </g>
              );
            })}
          </svg>
          {hover && rows[hover.index] ? (
            <Tooltip x={hover.x} y={hover.y}>
              <div className="muted small">
                {hourLabel(rows[hover.index]!.at, true)} –{' '}
                {hourLabel(rows[hover.index]!.end, false)}
              </div>
              {SERIES.map((s) => (
                <div key={s.key} className="viz-tooltip-row">
                  <span className="viz-key" style={{ background: s.color }} />
                  <strong>{rows[hover.index]![s.key]}</strong>
                  <span className="muted">{s.label}</span>
                </div>
              ))}
            </Tooltip>
          ) : null}
        </div>
      )}
    </figure>
  );
}

function TopTools({ tools }: { tools: Insights['topTools'] }) {
  const max = Math.max(1, ...tools.map((t) => t.calls));
  return (
    <figure className="card viz">
      <figcaption>
        <strong>Busiest tools</strong>
        <div className="muted small">Calls in the selected period</div>
      </figcaption>
      {tools.length === 0 ? (
        <div className="muted">No tool calls yet.</div>
      ) : (
        <div className="viz-hbars">
          {tools.map((t) => (
            <div
              key={`${t.server}__${t.tool}`}
              className="viz-hbar"
              title={`${t.calls} calls, ${t.errors} failed`}
            >
              <span className="mono small truncate">
                {t.server}__{t.tool}
              </span>
              <span className="viz-hbar-track">
                <span className="viz-hbar-fill" style={{ width: `${(t.calls / max) * 100}%` }} />
                <span className="viz-hbar-value">
                  {t.calls}
                  {t.errors ? <span className="muted"> · {t.errors} failed</span> : null}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </figure>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card stat-tile">
      <div className="muted small">{label}</div>
      <div className="stat-value">{value}</div>
      {note ? <div className="muted small">{note}</div> : null}
    </div>
  );
}

export function InsightsPage() {
  const isAdmin = useIsAdmin();
  const [hours, setHours] = useState<number>(24);
  const insights = useQuery({
    queryKey: ['insights', hours],
    queryFn: () => api.insights(hours),
    refetchInterval: 15_000,
    placeholderData: (previous) => previous,
  });
  const data = insights.data;
  const grafana = window.location.hostname.startsWith('app.')
    ? `${window.location.protocol}//grafana.${window.location.hostname.slice(4)}`
    : null;

  return (
    <>
      <PageHeader
        title="Insights"
        description={
          data?.ownOnly
            ? 'Your own tool calls: volume, failures and latency per server.'
            : 'Every tool call through the gateway: volume, failures and latency per server, and why an upstream is down.'
        }
        actions={
          isAdmin && grafana ? (
            <a className="btn" href={grafana} target="_blank" rel="noreferrer">
              Open Grafana
            </a>
          ) : null
        }
      />
      <div className="row filter-row" role="group" aria-label="Time range">
        {RANGES.map((r) => (
          <button
            key={r.hours}
            className={`btn small ${hours === r.hours ? 'primary' : ''}`}
            aria-pressed={hours === r.hours}
            onClick={() => setHours(r.hours)}
          >
            {r.label}
          </button>
        ))}
        {insights.isFetching ? <Spinner /> : null}
      </div>
      <ErrorNote error={insights.error} />
      {!data ? (
        <Spinner />
      ) : (
        <div className="stack" style={{ opacity: insights.isPlaceholderData ? 0.6 : 1 }}>
          <div className="kpi-row">
            <Tile label="Tool calls" value={compact(data.totals.calls)} />
            <Tile
              label="Failed upstream"
              value={percent(data.totals.errors, data.totals.calls)}
              note={`${data.totals.errors} calls: tool errors, timeouts, unreachable`}
            />
            <Tile
              label="Refused by the gateway"
              value={compact(data.totals.refused)}
              note="Permissions, disabled servers, unapproved tools"
            />
            <Tile
              label="Through the chat"
              value={percent(data.totals.chat, data.totals.calls)}
              note={`${data.totals.mcpClient} from MCP clients`}
            />
          </div>
          <CallsChart data={data.timeline} hours={hours} />
          <div className="card">
            <strong>Servers</strong>
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table className="numeric">
                <thead>
                  <tr>
                    <th>Server</th>
                    <th>Status</th>
                    <th>Calls</th>
                    <th>Failed</th>
                    <th>Refused</th>
                    <th>p50</th>
                    <th>p95</th>
                    <th>Last failure</th>
                  </tr>
                </thead>
                <tbody>
                  {data.servers.map((s) => (
                    <tr key={s.server}>
                      <td>
                        <div>{s.displayName ?? s.server}</div>
                        <div className="mono muted small">{s.server}__*</div>
                      </td>
                      <td>
                        {s.status ? (
                          <StatusBadge status={s.status} />
                        ) : (
                          <span className="muted">removed</span>
                        )}
                        {s.status === 'unreachable' && s.reason ? (
                          <div className="small muted">
                            {s.reason}
                            {s.message ? `: ${s.message}` : ''}
                          </div>
                        ) : null}
                      </td>
                      <td>{s.calls}</td>
                      <td>{s.calls ? percent(s.errors, s.calls) : '–'}</td>
                      <td>{s.refused}</td>
                      <td>{s.p50Ms === null ? '–' : duration(s.p50Ms)}</td>
                      <td>{s.p95Ms === null ? '–' : duration(s.p95Ms)}</td>
                      <td className="small muted" style={{ maxWidth: 260 }}>
                        {s.lastError ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <TopTools tools={data.topTools} />
        </div>
      )}
    </>
  );
}
