import type { ApiKey, CreatedApiKey, User } from '@ahjin/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useMe } from '../auth';
import {
  Badge,
  CodeBlock,
  Empty,
  ErrorNote,
  Field,
  Modal,
  PageHeader,
  Spinner,
} from '../components/ui';
import { api } from '../lib/api';
import { dateTime, timeAgo } from '../lib/format';
import { clientSnippets } from '../lib/snippets';

export const gatewayUrl = () => `${window.location.origin}/mcp`;

function keyState(key: ApiKey): { label: string; tone: string } {
  if (key.revokedAt) return { label: 'Revoked', tone: 'danger' };
  if (key.expiresAt && new Date(key.expiresAt) < new Date())
    return { label: 'Expired', tone: 'warning' };
  return { label: 'Active', tone: 'success' };
}

/** A key list with revoke buttons; used for your own keys and, by admins, for a member's keys. */
export function KeyTable({ userId }: { userId?: string }) {
  const client = useQueryClient();
  const keys = useQuery({ queryKey: ['keys', userId ?? 'me'], queryFn: () => api.keys(userId) });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeKey(id),
    onSettled: () => client.invalidateQueries({ queryKey: ['keys'] }),
  });
  if (keys.isPending) return <Spinner />;
  const list = keys.data?.keys ?? [];
  return (
    <>
      <ErrorNote error={keys.error ?? revoke.error} />
      {list.length === 0 ? (
        <Empty>No keys yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((key) => {
                const state = keyState(key);
                return (
                  <tr key={key.id}>
                    <td style={{ fontWeight: 600 }}>{key.name}</td>
                    <td className="mono">amcp_{key.prefix}_…</td>
                    <td title={dateTime(key.createdAt)}>{timeAgo(key.createdAt)}</td>
                    <td title={dateTime(key.lastUsedAt)}>{timeAgo(key.lastUsedAt)}</td>
                    <td>
                      <Badge tone={state.tone}>{state.label}</Badge>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {state.label === 'Active' ? (
                        <button
                          className="btn small danger"
                          disabled={revoke.isPending}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Revoke "${key.name}"? Clients using it stop working immediately.`,
                              )
                            ) {
                              revoke.mutate(key.id);
                            }
                          }}
                        >
                          Revoke
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Shows a new key once, with ready-to-paste settings for common MCP clients. */
export function NewKeyModal({ created, onClose }: { created: CreatedApiKey; onClose: () => void }) {
  const snippets = clientSnippets(gatewayUrl(), created.key);
  const [tab, setTab] = useState(snippets[0]!.id);
  const active = snippets.find((s) => s.id === tab)!;
  return (
    <Modal
      wide
      title={`Key "${created.name}" created`}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="stack">
        <div className="alert warning">
          Copy it now: the gateway stores only a hash, so this key is never shown again.
        </div>
        <div className="secret">{created.key}</div>
        <div>
          <h3>Connect a client</h3>
          <p className="muted small" style={{ marginTop: 0 }}>
            One URL and this key give the client every enabled server's tools. You never configure
            the servers themselves.
          </p>
          <div className="tabs">
            {snippets.map((s) => (
              <button
                key={s.id}
                className={`tab ${s.id === tab ? 'active' : ''}`}
                onClick={() => setTab(s.id)}
              >
                {s.client}
              </button>
            ))}
          </div>
          <div className="small muted" style={{ marginBottom: 6 }}>
            {active.where}
          </div>
          <CodeBlock code={active.code} />
        </div>
      </div>
    </Modal>
  );
}

export function CreateKeyForm({
  user,
  onCreated,
}: {
  user?: User;
  onCreated: (key: CreatedApiKey) => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [expires, setExpires] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api.createKey({
        name,
        ...(expires ? { expiresInDays: Number(expires) } : {}),
        ...(user ? { userId: user.id } : {}),
      }),
    onSuccess: async ({ key }) => {
      setName('');
      await client.invalidateQueries({ queryKey: ['keys'] });
      onCreated(key);
    },
  });
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <ErrorNote error={create.error} />
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="Key name" hint="Where you'll use it, e.g. Claude Code on laptop">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={60}
            placeholder="Claude Code"
          />
        </Field>
        <Field label="Expires">
          <select value={expires} onChange={(e) => setExpires(e.target.value)}>
            <option value="">Never (until revoked)</option>
            <option value="7">In 7 days</option>
            <option value="30">In 30 days</option>
            <option value="90">In 90 days</option>
          </select>
        </Field>
        <button className="btn primary" disabled={create.isPending || !name.trim()}>
          {create.isPending ? <Spinner /> : null} Create key
        </button>
      </div>
    </form>
  );
}

export function KeysPage() {
  const { data: me } = useMe();
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  return (
    <>
      <PageHeader
        title="API keys"
        description="Your personal keys for MCP clients such as Claude Code, Cursor or MCP Inspector. Every call made with them is logged under your name."
      />
      <div className="card">
        <h2>Gateway URL</h2>
        <CodeBlock code={gatewayUrl()} />
        <p className="muted small" style={{ marginBottom: 0 }}>
          Clients send <code>Authorization: Bearer &lt;your key&gt;</code>. Create a key below to
          get copy-paste settings for your client.
        </p>
      </div>
      <div className="card">
        <h2>New key</h2>
        <CreateKeyForm onCreated={setCreated} />
      </div>
      <div className="card">
        <h2>Your keys{me ? <span className="muted"> · {me.email}</span> : null}</h2>
        <KeyTable />
      </div>
      {created ? <NewKeyModal created={created} onClose={() => setCreated(null)} /> : null}
    </>
  );
}
