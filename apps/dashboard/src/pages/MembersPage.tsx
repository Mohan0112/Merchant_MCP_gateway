import type { CreatedApiKey, Role, User } from '@ahjin/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useMe } from '../auth';
import {
  Badge,
  CodeBlock,
  Empty,
  ErrorNote,
  Field,
  fieldError,
  Modal,
  PageHeader,
  Spinner,
} from '../components/ui';
import { api } from '../lib/api';
import { dateTime, timeAgo } from '../lib/format';
import { CreateKeyForm, KeyTable, NewKeyModal } from './KeysPage';

function InviteForm() {
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [link, setLink] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: () => api.invite(email, role),
    onSuccess: async ({ invitation }) => {
      setLink(invitation.link);
      setEmail('');
      await client.invalidateQueries({ queryKey: ['invitations'] });
    },
  });
  return (
    <div className="stack">
      <form
        className="row"
        style={{ alignItems: 'flex-end' }}
        onSubmit={(event) => {
          event.preventDefault();
          invite.mutate();
        }}
      >
        <Field label="Email" error={fieldError(invite.error, 'email')}>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="teammate@company.com"
          />
        </Field>
        <Field label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">Member: uses tools</option>
            <option value="admin">Admin: manages servers and members</option>
          </select>
        </Field>
        <button className="btn primary" disabled={invite.isPending}>
          {invite.isPending ? <Spinner /> : null} Create invitation
        </button>
      </form>
      <ErrorNote error={invite.error} />
      {link ? (
        <div className="stack">
          <div className="alert success">
            Invitation created. Send this one-time link to your teammate (valid for 72 hours):
          </div>
          <CodeBlock code={link} />
        </div>
      ) : null}
    </div>
  );
}

function PendingInvitations() {
  const client = useQueryClient();
  const invitations = useQuery({ queryKey: ['invitations'], queryFn: api.invitations });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeInvitation(id),
    onSettled: () => client.invalidateQueries({ queryKey: ['invitations'] }),
  });
  const now = new Date();
  const pending = (invitations.data?.invitations ?? []).filter(
    (i) => !i.acceptedAt && !i.revokedAt && new Date(i.expiresAt) > now,
  );
  if (!pending.length) return null;
  return (
    <div className="card">
      <h2>Pending invitations</h2>
      <ErrorNote error={revoke.error} />
      <table>
        <tbody>
          {pending.map((invitation) => (
            <tr key={invitation.id}>
              <td>{invitation.email}</td>
              <td>
                <Badge>{invitation.role}</Badge>
              </td>
              <td className="muted">expires {timeAgo(invitation.expiresAt)}</td>
              <td style={{ textAlign: 'right' }}>
                <button className="btn small danger" onClick={() => revoke.mutate(invitation.id)}>
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MemberKeys({ user, onClose }: { user: User; onClose: () => void }) {
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  return (
    <Modal wide title={`API keys of ${user.name}`} onClose={onClose}>
      <div className="stack">
        <KeyTable userId={user.id} />
        <div>
          <h3>Issue a key for {user.name}</h3>
          <CreateKeyForm user={user} onCreated={setCreated} />
        </div>
      </div>
      {created ? <NewKeyModal created={created} onClose={() => setCreated(null)} /> : null}
    </Modal>
  );
}

export function MembersPage() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: api.users });
  const [keysOf, setKeysOf] = useState<User | null>(null);
  const update = useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: { role?: Role; status?: 'active' | 'disabled' };
    }) => api.updateUser(id, patch),
    onSettled: () => client.invalidateQueries({ queryKey: ['users'] }),
  });
  return (
    <>
      <PageHeader
        title="Members"
        description="Admins manage servers and members; members use the tools. Disabling someone ends their sessions and stops their keys."
      />
      <div className="card">
        <h2>Invite a teammate</h2>
        <InviteForm />
      </div>
      <PendingInvitations />
      <div className="card">
        <h2>Team</h2>
        <ErrorNote error={users.error ?? update.error} />
        {users.isPending ? <Spinner /> : null}
        {users.data && users.data.users.length === 0 ? <Empty>No members yet.</Empty> : null}
        {users.data ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last sign-in</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.data.users.map((user) => {
                  const self = user.id === me?.id;
                  return (
                    <tr key={user.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>
                          {user.name} {self ? <span className="muted small">(you)</span> : null}
                        </div>
                        <div className="muted small">{user.email}</div>
                      </td>
                      <td>
                        <select
                          value={user.role}
                          disabled={self || update.isPending}
                          onChange={(e) =>
                            update.mutate({ id: user.id, patch: { role: e.target.value as Role } })
                          }
                          style={{ width: 'auto' }}
                        >
                          <option value="member">member</option>
                          <option value="admin">admin</option>
                        </select>
                      </td>
                      <td>
                        <Badge tone={user.status === 'active' ? 'success' : 'danger'}>
                          {user.status}
                        </Badge>
                      </td>
                      <td title={dateTime(user.lastLoginAt)}>{timeAgo(user.lastLoginAt)}</td>
                      <td>
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn small" onClick={() => setKeysOf(user)}>
                            API keys
                          </button>
                          {!self ? (
                            <button
                              className={`btn small ${user.status === 'active' ? 'danger' : ''}`}
                              disabled={update.isPending}
                              onClick={() =>
                                update.mutate({
                                  id: user.id,
                                  patch: {
                                    status: user.status === 'active' ? 'disabled' : 'active',
                                  },
                                })
                              }
                            >
                              {user.status === 'active' ? 'Disable' : 'Enable'}
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
      {keysOf ? <MemberKeys user={keysOf} onClose={() => setKeysOf(null)} /> : null}
    </>
  );
}
