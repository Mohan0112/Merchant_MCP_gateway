import type { Server, TestConnectionResult, ToolInfo, UpstreamAuthType } from '@ahjin/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useIsAdmin } from '../auth';
import {
  Badge,
  Empty,
  ErrorNote,
  Field,
  fieldError,
  Modal,
  PageHeader,
  Spinner,
  StatusBadge,
  Switch,
} from '../components/ui';
import { api } from '../lib/api';
import { duration, timeAgo } from '../lib/format';

const REASONS: Record<string, string> = {
  DNS: 'Host name not found',
  CONNECTION_REFUSED: 'Connection refused',
  TIMEOUT: 'Timed out',
  TLS: 'TLS problem',
  AUTH: 'Credential rejected',
  HTTP_ERROR: 'HTTP error',
  PROTOCOL: 'Not a working MCP endpoint',
};

export function ServersPage() {
  const isAdmin = useIsAdmin();
  const client = useQueryClient();
  const servers = useQuery({
    queryKey: ['servers'],
    queryFn: api.servers,
    // Status changes on its own (an upstream dies or comes back), so keep the page live.
    refetchInterval: 5000,
  });
  const [editing, setEditing] = useState<Server | 'new' | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: (server: Server) => api.updateServer(server.id, { enabled: !server.enabled }),
    onSettled: () => client.invalidateQueries({ queryKey: ['servers'] }),
  });

  const list = servers.data?.servers ?? [];
  const connected = list.filter((s) => s.status === 'connected');
  return (
    <>
      <PageHeader
        title="MCP servers"
        description={
          list.length
            ? `${connected.length} of ${list.length} connected · ${connected.reduce((n, s) => n + s.toolCount, 0)} tools available through the gateway`
            : 'Servers the gateway connects to on behalf of your team.'
        }
        actions={
          isAdmin ? (
            <button className="btn primary" onClick={() => setEditing('new')}>
              + Add server
            </button>
          ) : null
        }
      />
      <ErrorNote error={servers.error ?? toggle.error} />
      {servers.isPending ? <Spinner /> : null}
      {servers.data && list.length === 0 ? (
        <div className="card">
          <Empty>No servers yet.{isAdmin ? ' Add one to give your team its tools.' : ''}</Empty>
        </div>
      ) : null}
      <div className="grid">
        {list.map((server) => (
          <div key={server.id} className="card server-card" onClick={() => setViewing(server.id)}>
            <div className="spread">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700 }} className="truncate">
                  {server.displayName}
                </div>
                <div className="mono muted">{server.slug}__*</div>
              </div>
              <StatusBadge status={server.status} />
            </div>
            {server.status === 'unreachable' ? (
              <div className="reason">
                {REASONS[server.statusReason ?? ''] ?? 'Unreachable'}
                {server.statusMessage ? `: ${server.statusMessage}` : ''}
              </div>
            ) : null}
            <dl className="meta">
              <dt>Tools</dt>
              <dd>{server.toolCount}</dd>
              <dt>Checked</dt>
              <dd>{timeAgo(server.lastCheckedAt)}</dd>
              <dt>Timeout</dt>
              <dd>{duration(server.timeoutMs)}</dd>
              {isAdmin ? (
                <>
                  <dt>URL</dt>
                  <dd className="mono truncate" title={server.url ?? ''}>
                    {server.url}
                  </dd>
                </>
              ) : null}
            </dl>
            <div className="spread">
              <div className="row">
                {server.seeded ? <Badge tone="info">built-in</Badge> : null}
                {server.hasCredential ? (
                  <Badge>{server.authType} credential</Badge>
                ) : (
                  <Badge>no credential</Badge>
                )}
              </div>
              {isAdmin ? (
                <div className="row">
                  <button
                    className="btn small"
                    onClick={(event) => {
                      event.stopPropagation();
                      setEditing(server);
                    }}
                  >
                    Edit
                  </button>
                  <Switch
                    on={server.enabled}
                    label={server.enabled ? 'Disable server' : 'Enable server'}
                    disabled={toggle.isPending}
                    onChange={() => toggle.mutate(server)}
                  />
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {viewing ? <ServerDetail id={viewing} onClose={() => setViewing(null)} /> : null}
      {editing ? (
        <ServerForm server={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </>
  );
}

function ToolCard({ slug, tool }: { slug: string; tool: ToolInfo }) {
  const hints = (tool.annotations ?? {}) as { readOnlyHint?: boolean; destructiveHint?: boolean };
  const properties = Object.keys(
    ((tool.inputSchema as { properties?: Record<string, unknown> } | null)?.properties ??
      {}) as object,
  );
  return (
    <div className="tool">
      <div className="spread">
        <code style={{ fontWeight: 600 }}>
          {slug}__{tool.name}
        </code>
        <div className="row">
          {hints.readOnlyHint ? <Badge tone="success">read-only</Badge> : null}
          {hints.destructiveHint ? <Badge tone="danger">destructive</Badge> : null}
        </div>
      </div>
      {tool.description ? (
        <div className="small" style={{ marginTop: 4 }}>
          {tool.description}
        </div>
      ) : null}
      {properties.length ? (
        <div className="small muted" style={{ marginTop: 4 }}>
          Arguments: <span className="mono">{properties.join(', ')}</span>
        </div>
      ) : null}
    </div>
  );
}

function ServerDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const isAdmin = useIsAdmin();
  const client = useQueryClient();
  const detail = useQuery({
    queryKey: ['server', id],
    queryFn: () => api.server(id),
    refetchInterval: 5000,
  });
  const refresh = useMutation({
    mutationFn: () => api.refreshServer(id),
    onSettled: () => client.invalidateQueries({ queryKey: ['server', id] }),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteServer(id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['servers'] });
      onClose();
    },
  });
  const server = detail.data?.server;
  return (
    <Modal
      wide
      title={server ? server.displayName : 'Server'}
      onClose={onClose}
      footer={
        isAdmin && server ? (
          <>
            <button
              className="btn danger"
              disabled={remove.isPending}
              onClick={() => {
                if (
                  window.confirm(`Remove ${server.displayName}? Its tools disappear for everyone.`)
                )
                  remove.mutate();
              }}
            >
              Remove server
            </button>
            <button className="btn" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
              {refresh.isPending ? <Spinner /> : null} Reconnect now
            </button>
          </>
        ) : undefined
      }
    >
      <ErrorNote error={detail.error ?? refresh.error ?? remove.error} />
      {!server ? <Spinner /> : null}
      {server ? (
        <div className="stack">
          <div className="row">
            <StatusBadge status={server.status} />
            {server.protocolEra ? (
              <Badge>
                {server.protocolEra === 'modern' ? 'MCP 2026-07-28' : 'MCP 2025 (legacy)'}
              </Badge>
            ) : null}
            <span className="muted small">
              since {timeAgo(server.statusSince)} · checked {timeAgo(server.lastCheckedAt)}
            </span>
          </div>
          {server.status === 'unreachable' ? (
            <div className="alert">
              {REASONS[server.statusReason ?? ''] ?? 'Unreachable'}
              {server.statusMessage ? `: ${server.statusMessage}` : ''}. The gateway keeps retrying
              with backoff; its tools are hidden until it answers again.
            </div>
          ) : null}
          {server.status === 'disabled' ? (
            <div className="alert warning">
              Disabled by an admin: its tools are hidden from every client and the chat.
            </div>
          ) : null}
          <h3>
            Tools <span className="muted">({detail.data?.tools.length ?? 0})</span>
          </h3>
          <div>
            {detail.data?.tools.length ? (
              detail.data.tools.map((tool) => (
                <ToolCard key={tool.name} slug={server.slug} tool={tool} />
              ))
            ) : (
              <Empty>No tools known yet.</Empty>
            )}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

interface FormState {
  slug: string;
  displayName: string;
  url: string;
  authType: UpstreamAuthType;
  authHeaderName: string;
  credential: string;
  timeoutSeconds: string;
}

function ServerForm({ server, onClose }: { server: Server | null; onClose: () => void }) {
  const client = useQueryClient();
  const [form, setForm] = useState<FormState>({
    slug: server?.slug ?? '',
    displayName: server?.displayName ?? '',
    url: server?.url ?? '',
    authType: server?.authType ?? 'none',
    authHeaderName: server?.authHeaderName ?? '',
    credential: '',
    timeoutSeconds: String((server?.timeoutMs ?? 30_000) / 1000),
  });
  const [test, setTest] = useState<TestConnectionResult | null>(null);
  const set = (patch: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    setTest(null);
  };
  const credentialFields = () => ({
    authType: form.authType,
    ...(form.authType === 'header' ? { authHeaderName: form.authHeaderName } : {}),
    ...(form.credential ? { credential: form.credential } : {}),
  });

  const testConnection = useMutation({
    mutationFn: () => api.testServer({ url: form.url, timeoutMs: 10_000, ...credentialFields() }),
    onSuccess: ({ result }) => setTest(result),
  });
  const save = useMutation({
    mutationFn: async () => {
      const timeoutMs = Math.round(Number(form.timeoutSeconds) * 1000);
      if (server) {
        return api.updateServer(server.id, {
          displayName: form.displayName,
          url: form.url,
          timeoutMs,
          ...credentialFields(),
        });
      }
      return api.createServer({
        slug: form.slug,
        displayName: form.displayName,
        url: form.url,
        enabled: true,
        timeoutMs,
        ...credentialFields(),
      });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['servers'] });
      onClose();
    },
  });
  const editingCredential = server && server.hasCredential && form.authType === server.authType;
  return (
    <Modal
      title={server ? `Edit ${server.displayName}` : 'Add an MCP server'}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn"
            onClick={() => testConnection.mutate()}
            disabled={!form.url || testConnection.isPending}
          >
            {testConnection.isPending ? <Spinner /> : null} Test connection
          </button>
          <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <Spinner /> : null} {server ? 'Save changes' : 'Add server'}
          </button>
        </>
      }
    >
      <div className="stack">
        <ErrorNote error={save.error ?? testConnection.error} />
        <div className="form-grid">
          <Field label="Name" error={fieldError(save.error, 'displayName')}>
            <input
              value={form.displayName}
              onChange={(e) => set({ displayName: e.target.value })}
              placeholder="GitHub issues"
            />
          </Field>
          <Field
            label="Slug"
            hint={
              server
                ? 'Fixed: clients cache tool names.'
                : 'Tool prefix, e.g. github → github__list_issues'
            }
            error={fieldError(save.error, 'slug')}
          >
            <input
              className="mono"
              value={form.slug}
              disabled={Boolean(server)}
              onChange={(e) => set({ slug: e.target.value.toLowerCase() })}
              placeholder="github"
            />
          </Field>
          <Field
            className="full"
            label="Streamable HTTP URL"
            hint="The server's MCP endpoint, for example https://example.com/mcp"
            error={fieldError(save.error, 'url')}
          >
            <input
              className="mono"
              value={form.url}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="https://…/mcp"
            />
          </Field>
          <Field
            label="Credential"
            hint="Sent by the gateway only; never shown to members or clients."
          >
            <select
              value={form.authType}
              onChange={(e) => set({ authType: e.target.value as UpstreamAuthType })}
            >
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="header">Custom header</option>
            </select>
          </Field>
          <Field label="Timeout (seconds)" error={fieldError(save.error, 'timeoutMs')}>
            <input
              type="number"
              min={1}
              max={120}
              value={form.timeoutSeconds}
              onChange={(e) => set({ timeoutSeconds: e.target.value })}
            />
          </Field>
          {form.authType === 'header' ? (
            <Field label="Header name" error={fieldError(save.error, 'authHeaderName')}>
              <input
                className="mono"
                value={form.authHeaderName}
                onChange={(e) => set({ authHeaderName: e.target.value })}
                placeholder="X-API-Key"
              />
            </Field>
          ) : null}
          {form.authType !== 'none' ? (
            <Field
              className={form.authType === 'header' ? '' : 'full'}
              label={form.authType === 'bearer' ? 'Token' : 'Header value'}
              hint={
                editingCredential
                  ? 'Leave empty to keep the stored credential.'
                  : 'Stored encrypted (AES-256-GCM).'
              }
              error={fieldError(save.error, 'credential')}
            >
              <input
                type="password"
                autoComplete="off"
                value={form.credential}
                onChange={(e) => set({ credential: e.target.value })}
                placeholder={editingCredential ? '••••••••  (unchanged)' : ''}
              />
            </Field>
          ) : null}
        </div>
        {test ? (
          test.ok ? (
            <div className="alert success">
              Connected in {duration(test.latencyMs)} (
              {test.protocolEra === 'modern' ? 'MCP 2026-07-28' : 'MCP 2025'}), {test.tools.length}{' '}
              tools: <span className="mono">{test.tools.join(', ')}</span>
            </div>
          ) : (
            <div className="alert">
              {REASONS[test.reason] ?? test.reason}: {test.message}
            </div>
          )
        ) : null}
        {editingCredential && !form.credential && testConnection.isIdle ? (
          <div className="small muted">
            Testing an existing server without re-entering its credential tests without one.
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
