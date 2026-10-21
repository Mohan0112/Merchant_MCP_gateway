import type { Store, StorePhase } from '@ahjin/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useIsAdmin } from '../auth';
import { Badge, Empty, ErrorNote, Field, fieldError, PageHeader, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';

const PHASE: Record<StorePhase, { tone: string; label: string }> = {
  Provisioning: { tone: 'warning', label: 'Provisioning' },
  Ready: { tone: 'success', label: 'Ready' },
  Failed: { tone: 'danger', label: 'Failed' },
  Deleting: { tone: '', label: 'Deleting' },
};

/** "Acme Laptops!" → "acme-laptops", trimmed to the 14 characters a store address may have. */
const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 14)
    .replace(/-+$/, '');

const domain = () =>
  window.location.hostname.startsWith('app.') ? window.location.hostname.slice(4) : 'example.com';

function NewStore() {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [touched, setTouched] = useState(false);
  const effective = touched ? slug : slugify(name);
  const create = useMutation({
    mutationFn: () => api.createStore({ name, slug: effective }),
    onSuccess: () => {
      setName('');
      setSlug('');
      setTouched(false);
      void client.invalidateQueries({ queryKey: ['stores'] });
    },
  });
  return (
    <form
      className="card stack"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <strong>New store</strong>
      <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="Name" error={fieldError(create.error, 'name')}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Laptops"
            required
          />
        </Field>
        <Field
          label="Address"
          error={fieldError(create.error, 'slug')}
          hint={
            effective
              ? `${effective}.${domain()} · tools store-${effective}__*`
              : '2–14 letters, digits or dashes'
          }
        >
          <input
            className="mono"
            value={effective}
            onChange={(e) => {
              setTouched(true);
              setSlug(e.target.value.toLowerCase());
            }}
            placeholder="acme"
            required
          />
        </Field>
        <button className="btn primary" disabled={create.isPending || !name || !effective}>
          {create.isPending ? <Spinner /> : null} Create store
        </button>
      </div>
      <ErrorNote error={create.error} />
      <span className="muted small">
        Each store gets its own namespace with WordPress, MariaDB, volumes, Secrets and an Ingress
        host, plus its own WooCommerce MCP server, registered in the gateway automatically. It takes
        a few minutes.
      </span>
    </form>
  );
}

function StoreRow({ store, showOwner }: { store: Store; showOwner: boolean }) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ['stores'] });
  const remove = useMutation({ mutationFn: () => api.deleteStore(store.slug), onSettled: refresh });
  const retry = useMutation({ mutationFn: () => api.retryStore(store.slug), onSettled: refresh });
  const phase = PHASE[store.phase];
  const busy = store.phase === 'Provisioning' || store.phase === 'Deleting';
  return (
    <tr>
      <td>
        <div style={{ fontWeight: 600 }}>{store.name}</div>
        <div className="mono muted small">{store.upstreamSlug}__*</div>
      </td>
      <td>
        <div className="row">
          {busy ? <Spinner /> : null}
          <Badge tone={phase.tone}>{phase.label}</Badge>
        </div>
        {store.phase !== 'Ready' && store.message ? (
          <div className="small muted" style={{ maxWidth: 340 }}>
            {store.reason ? `${store.reason}: ` : ''}
            {store.message}
          </div>
        ) : null}
      </td>
      <td>
        {store.url && store.phase === 'Ready' ? (
          <div className="stack" style={{ gap: 2 }}>
            <a href={store.url} target="_blank" rel="noreferrer">
              {store.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
            </a>
            <a className="small" href={`${store.url}wp-admin/`} target="_blank" rel="noreferrer">
              wp-admin
            </a>
          </div>
        ) : (
          <span className="muted">–</span>
        )}
      </td>
      {showOwner ? <td className="small">{store.ownerEmail}</td> : null}
      <td className="muted small">{timeAgo(store.createdAt)}</td>
      <td style={{ textAlign: 'right' }}>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {store.phase === 'Failed' ? (
            <button className="btn small" disabled={retry.isPending} onClick={() => retry.mutate()}>
              Retry
            </button>
          ) : null}
          {store.phase !== 'Deleting' ? (
            <button
              className="btn small danger"
              disabled={remove.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    `Delete ${store.name}? Its namespace, database, volumes, Secrets and MCP tools are removed for good.`,
                  )
                )
                  remove.mutate();
              }}
            >
              Delete
            </button>
          ) : null}
        </div>
        <ErrorNote error={remove.error ?? retry.error} />
      </td>
    </tr>
  );
}

export function StoresPage() {
  const isAdmin = useIsAdmin();
  const stores = useQuery({
    queryKey: ['stores'],
    queryFn: api.stores,
    // Fast while something is in progress, slow otherwise.
    refetchInterval: (query) =>
      query.state.data?.stores.some((s) => s.phase === 'Provisioning' || s.phase === 'Deleting')
        ? 3000
        : 15_000,
  });
  const list = stores.data?.stores ?? [];
  return (
    <>
      <PageHeader
        title="Stores"
        description="Create WooCommerce stores on demand. Each new store's tools appear in every MCP client and in the chat under their own prefix, so you can ask about several stores at once."
      />
      <ErrorNote error={stores.error} />
      {stores.isPending ? <Spinner /> : null}
      {stores.data && !stores.data.enabled ? (
        <div className="card">
          <Empty>
            Store provisioning is switched off on this platform (Helm value global.stores.enabled).
          </Empty>
        </div>
      ) : null}
      {stores.data?.enabled ? (
        <>
          <NewStore />
          <div className="card">
            {list.length === 0 ? (
              <Empty>No stores yet.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Store</th>
                      <th>Status</th>
                      <th>Address</th>
                      {isAdmin ? <th>Owner</th> : null}
                      <th>Created</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((store) => (
                      <StoreRow key={store.slug} store={store} showOwner={isAdmin} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {list.some((s) => s.phase === 'Ready') ? (
              <div className="muted small" style={{ marginTop: 10 }}>
                Try in the chat: “Compare today’s orders across all our stores.”
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}
