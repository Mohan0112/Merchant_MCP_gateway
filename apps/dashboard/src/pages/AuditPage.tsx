import type { AuditChannel, AuditOutcome } from '@ahjin/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useIsAdmin } from '../auth';
import { Badge, Empty, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { dateTime, duration, timeAgo } from '../lib/format';

const OUTCOMES: Record<AuditOutcome, { label: string; tone: string }> = {
  success: { label: 'Success', tone: 'success' },
  tool_error: { label: 'Tool error', tone: 'warning' },
  timeout: { label: 'Timeout', tone: 'danger' },
  upstream_unreachable: { label: 'Unreachable', tone: 'danger' },
  rejected_disabled: { label: 'Server disabled', tone: '' },
  denied_auth: { label: 'Auth denied', tone: 'danger' },
  denied_policy: { label: 'Not allowed', tone: 'danger' },
  not_found: { label: 'Unknown tool', tone: 'warning' },
  pending_review: { label: 'Awaiting review', tone: 'warning' },
};

const CHANNELS: Record<AuditChannel, string> = {
  mcp_client: 'MCP client',
  chat_agent: 'Chat agent',
};

interface Filters {
  userId: string;
  server: string;
  tool: string;
  outcome: string;
  channel: string;
}

const EMPTY: Filters = { userId: '', server: '', tool: '', outcome: '', channel: '' };

export function AuditPage() {
  const isAdmin = useIsAdmin();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const users = useQuery({ queryKey: ['users'], queryFn: api.users, enabled: isAdmin });
  const servers = useQuery({ queryKey: ['servers'], queryFn: api.servers });
  const log = useInfiniteQuery({
    queryKey: ['audit', filters],
    queryFn: ({ pageParam }) =>
      api.audit({
        ...(filters.userId ? { userId: filters.userId } : {}),
        ...(filters.server ? { server: filters.server } : {}),
        ...(filters.tool ? { tool: filters.tool } : {}),
        ...(filters.outcome ? { outcome: filters.outcome as AuditOutcome } : {}),
        ...(filters.channel ? { channel: filters.channel as AuditChannel } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
        limit: 50,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });
  const entries = log.data?.pages.flatMap((page) => page.entries) ?? [];
  const set = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }));

  return (
    <>
      <PageHeader
        title="Audit log"
        description={
          isAdmin
            ? 'Every tool call through the gateway, by anyone: who, which server and tool, when, how long, and the outcome.'
            : 'Every tool call made with your keys or by the chat agent on your behalf.'
        }
        actions={
          <button className="btn" onClick={() => void log.refetch()} disabled={log.isFetching}>
            {log.isFetching ? <Spinner /> : null} Refresh
          </button>
        }
      />
      <div className="card">
        <div className="row" style={{ marginBottom: 14 }}>
          {isAdmin ? (
            <select
              value={filters.userId}
              onChange={(e) => set({ userId: e.target.value })}
              style={{ width: 'auto' }}
            >
              <option value="">All users</option>
              {users.data?.users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name} ({user.email})
                </option>
              ))}
            </select>
          ) : null}
          <select
            value={filters.server}
            onChange={(e) => set({ server: e.target.value })}
            style={{ width: 'auto' }}
          >
            <option value="">All servers</option>
            {servers.data?.servers.map((server) => (
              <option key={server.id} value={server.slug}>
                {server.displayName}
              </option>
            ))}
          </select>
          <input
            value={filters.tool}
            onChange={(e) => set({ tool: e.target.value })}
            placeholder="Tool, e.g. list_orders"
            style={{ width: 200 }}
          />
          <select
            value={filters.outcome}
            onChange={(e) => set({ outcome: e.target.value })}
            style={{ width: 'auto' }}
          >
            <option value="">All outcomes</option>
            {Object.entries(OUTCOMES).map(([value, { label }]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            value={filters.channel}
            onChange={(e) => set({ channel: e.target.value })}
            style={{ width: 'auto' }}
          >
            <option value="">All channels</option>
            {Object.entries(CHANNELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {JSON.stringify(filters) !== JSON.stringify(EMPTY) ? (
            <button className="btn link small" onClick={() => setFilters(EMPTY)}>
              Clear filters
            </button>
          ) : null}
        </div>
        <ErrorNote error={log.error} />
        {log.isPending ? <Spinner /> : null}
        {log.data && entries.length === 0 ? <Empty>No tool calls match.</Empty> : null}
        {entries.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>User</th>
                  <th>Via</th>
                  <th>Server</th>
                  <th>Tool</th>
                  <th>Duration</th>
                  <th>Outcome</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const outcome = OUTCOMES[entry.outcome];
                  return (
                    <tr key={entry.id}>
                      <td title={dateTime(entry.occurredAt)} style={{ whiteSpace: 'nowrap' }}>
                        {timeAgo(entry.occurredAt)}
                      </td>
                      <td>
                        <div>{entry.userName ?? '—'}</div>
                        <div className="muted small">{entry.userEmail}</div>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{CHANNELS[entry.channel]}</td>
                      <td className="mono">{entry.serverSlug ?? '—'}</td>
                      <td className="mono">{entry.toolName ?? '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{duration(entry.durationMs)}</td>
                      <td>
                        <Badge tone={outcome.tone}>{outcome.label}</Badge>
                      </td>
                      <td
                        className="small muted"
                        style={{ maxWidth: 320 }}
                        title={entry.errorMessage ?? ''}
                      >
                        <div className="truncate">{entry.errorMessage ?? ''}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {log.hasNextPage ? (
          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <button
              className="btn"
              onClick={() => void log.fetchNextPage()}
              disabled={log.isFetchingNextPage}
            >
              {log.isFetchingNextPage ? <Spinner /> : null} Load older entries
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}
