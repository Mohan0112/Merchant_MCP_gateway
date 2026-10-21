import type { CreatePolicyRequest, Policy, Role } from '@ahjin/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Empty, ErrorNote, Field, fieldError, PageHeader, Spinner } from '../components/ui';
import { api } from '../lib/api';

/** The brief's example: members can read orders, but only admins create products or change status. */
const READ_ONLY_MEMBERS: CreatePolicyRequest = {
  subjectType: 'role',
  role: 'member',
  server: '*',
  tool: '*',
  scope: 'writes',
  effect: 'deny',
  note: 'members can only read',
};

function subjectOf(policy: Policy): string {
  return policy.subjectType === 'role' ? `Every ${policy.role}` : (policy.userEmail ?? 'a user');
}

function RuleForm() {
  const client = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: api.users });
  const servers = useQuery({ queryKey: ['servers'], queryFn: api.servers });
  const [form, setForm] = useState<CreatePolicyRequest>({
    subjectType: 'role',
    role: 'member',
    server: '*',
    tool: '*',
    scope: 'writes',
    effect: 'deny',
    note: '',
  });
  const set = (patch: Partial<CreatePolicyRequest>) => setForm((f) => ({ ...f, ...patch }));
  const create = useMutation({
    mutationFn: () => api.createPolicy(form),
    onSuccess: () => {
      set({ note: '' });
      void client.invalidateQueries({ queryKey: ['policies'] });
      void client.invalidateQueries({ queryKey: ['effective'] });
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
      <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="Applies to">
          <select
            value={form.subjectType === 'role' ? `role:${form.role}` : `user:${form.userId ?? ''}`}
            onChange={(e) => {
              const [type, value] = e.target.value.split(':');
              set(
                type === 'role'
                  ? { subjectType: 'role', role: value as Role, userId: undefined }
                  : { subjectType: 'user', userId: value, role: undefined },
              );
            }}
          >
            <option value="role:member">Every member</option>
            <option value="role:admin">Every admin</option>
            {(users.data?.users ?? []).map((user) => (
              <option key={user.id} value={`user:${user.id}`}>
                {user.name} ({user.email})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Server">
          <select value={form.server} onChange={(e) => set({ server: e.target.value })}>
            <option value="*">Every server</option>
            {(servers.data?.servers ?? []).map((server) => (
              <option key={server.id} value={server.slug}>
                {server.displayName} ({server.slug})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tool" error={fieldError(create.error, 'tool')}>
          <input
            value={form.tool}
            onChange={(e) => set({ tool: e.target.value })}
            placeholder="* or create_*"
            style={{ width: 150 }}
          />
        </Field>
        <Field label="Which tools">
          <select
            value={form.scope}
            onChange={(e) => set({ scope: e.target.value as 'all' | 'writes' })}
          >
            <option value="writes">Only tools that change data</option>
            <option value="all">All matching tools</option>
          </select>
        </Field>
        <Field label="Effect">
          <select
            value={form.effect}
            onChange={(e) => set({ effect: e.target.value as 'allow' | 'deny' })}
          >
            <option value="deny">Deny</option>
            <option value="allow">Allow</option>
          </select>
        </Field>
        <Field label="Note (shown when a call is refused)">
          <input
            value={form.note ?? ''}
            onChange={(e) => set({ note: e.target.value })}
            placeholder="e.g. members can only read"
          />
        </Field>
        <button className="btn primary" disabled={create.isPending}>
          {create.isPending ? <Spinner /> : null} Add rule
        </button>
      </div>
      <ErrorNote error={create.error} />
    </form>
  );
}

function EffectiveTools() {
  const users = useQuery({ queryKey: ['users'], queryFn: api.users });
  const [userId, setUserId] = useState('');
  const effective = useQuery({
    queryKey: ['effective', userId],
    queryFn: () => api.effectiveTools(userId || undefined),
  });
  const policies = useQuery({ queryKey: ['policies'], queryFn: api.policies });
  const byId = new Map((policies.data?.policies ?? []).map((p) => [p.id, p]));
  const tools = effective.data?.tools ?? [];
  return (
    <div className="card stack">
      <div className="spread">
        <h2 style={{ margin: 0 }}>Effective tools</h2>
        <select value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">You</option>
          {(users.data?.users ?? []).map((user) => (
            <option key={user.id} value={user.id}>
              {user.name} ({user.role})
            </option>
          ))}
        </select>
      </div>
      <span className="muted small">
        What this person's MCP clients and chat see. Hidden tools are also refused if called
        directly, and the refusal is in the audit log.
      </span>
      <ErrorNote error={effective.error} />
      {effective.isPending ? <Spinner /> : null}
      {tools.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th>Kind</th>
                <th>Access</th>
                <th>Because of</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => {
                const rule = tool.policyId ? byId.get(tool.policyId) : undefined;
                return (
                  <tr key={tool.name}>
                    <td className="mono">{tool.name}</td>
                    <td>{tool.readOnly ? 'reads' : 'changes data'}</td>
                    <td>
                      {tool.allowed ? (
                        <Badge tone="success">allowed</Badge>
                      ) : (
                        <Badge tone="danger">hidden</Badge>
                      )}
                    </td>
                    <td className="muted small">
                      {rule
                        ? `${rule.effect} rule for ${subjectOf(rule).toLowerCase()}${rule.note ? `: ${rule.note}` : ''}`
                        : 'no rule (allowed by default)'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : effective.data ? (
        <Empty>No tools are connected right now.</Empty>
      ) : null}
    </div>
  );
}

export function PermissionsPage() {
  const client = useQueryClient();
  const policies = useQuery({ queryKey: ['policies'], queryFn: api.policies });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['policies'] });
    void client.invalidateQueries({ queryKey: ['effective'] });
  };
  const remove = useMutation({ mutationFn: api.deletePolicy, onSettled: refresh });
  const preset = useMutation({
    mutationFn: () => api.createPolicy(READ_ONLY_MEMBERS),
    onSettled: refresh,
  });
  const list = policies.data?.policies ?? [];
  const hasPreset = list.some(
    (p) =>
      p.subjectType === 'role' &&
      p.role === 'member' &&
      p.server === '*' &&
      p.tool === '*' &&
      p.scope === 'writes' &&
      p.effect === 'deny',
  );
  return (
    <>
      <PageHeader
        title="Tool permissions"
        description="Choose who may use which tools. A person's own rules come before their role's; at the same level a deny wins over an allow; with no rule, a tool is allowed."
        actions={
          hasPreset ? null : (
            <button className="btn" disabled={preset.isPending} onClick={() => preset.mutate()}>
              Members can only read
            </button>
          )
        }
      />
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Rules</h2>
        <ErrorNote error={policies.error ?? remove.error ?? preset.error} />
        {policies.isPending ? <Spinner /> : null}
        {policies.data && !list.length ? (
          <Empty>No rules: everyone can use every enabled tool.</Empty>
        ) : null}
        {list.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Applies to</th>
                  <th>Server</th>
                  <th>Tool</th>
                  <th>Which tools</th>
                  <th>Effect</th>
                  <th>Note</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((policy) => (
                  <tr key={policy.id}>
                    <td>{subjectOf(policy)}</td>
                    <td className="mono">
                      {policy.server === '*' ? 'every server' : policy.server}
                    </td>
                    <td className="mono">{policy.tool}</td>
                    <td>{policy.scope === 'writes' ? 'only tools that change data' : 'all'}</td>
                    <td>
                      <Badge tone={policy.effect === 'deny' ? 'danger' : 'success'}>
                        {policy.effect}
                      </Badge>
                    </td>
                    <td className="muted">{policy.note}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn small danger"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(policy.id)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <h3>Add a rule</h3>
        <RuleForm />
        <span className="muted small">
          “Tools that change data” are those an MCP server doesn't mark as read-only. A malicious
          server could mislabel a tool, so for untrusted servers name the tools you allow instead.
        </span>
      </div>
      <EffectiveTools />
    </>
  );
}
