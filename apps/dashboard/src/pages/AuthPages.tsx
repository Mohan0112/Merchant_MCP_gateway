import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { useMe } from '../auth';
import { Brand } from '../components/Layout';
import { ErrorNote, Field, fieldError, Spinner } from '../components/ui';
import { api } from '../lib/api';

export function LoginPage() {
  const me = useMe();
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api.login(email, password),
    onSuccess: ({ user }) => {
      client.setQueryData(['me'], user);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(user.mustChangePassword ? '/change-password' : (from ?? '/'), { replace: true });
    },
  });
  if (me.data && !login.isPending) return <Navigate to="/" replace />;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate();
  };
  return (
    <div className="auth-page">
      <form className="card auth-card stack" onSubmit={submit}>
        <Brand />
        <h2 style={{ textAlign: 'center' }}>Sign in</h2>
        <ErrorNote error={login.error} />
        <Field label="Email">
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <button className="btn primary" disabled={login.isPending}>
          {login.isPending ? <Spinner /> : null} Sign in
        </button>
        <p className="muted small" style={{ margin: 0, textAlign: 'center' }}>
          New here? Ask an admin for an invitation link.
        </p>
      </form>
    </div>
  );
}

export function AcceptInvitePage() {
  const { token = '' } = useParams();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const invitation = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api.describeInvitation(token),
    retry: false,
  });
  const accept = useMutation({
    mutationFn: () => api.acceptInvitation(token, name, password),
    onSuccess: ({ user }) => {
      client.setQueryData(['me'], user);
      navigate('/', { replace: true });
    },
  });
  const mismatch = confirm.length > 0 && confirm !== password;
  return (
    <div className="auth-page">
      <form
        className="card auth-card stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!mismatch) accept.mutate();
        }}
      >
        <Brand />
        <h2 style={{ textAlign: 'center' }}>Join your team</h2>
        {invitation.isPending ? <Spinner /> : null}
        <ErrorNote error={invitation.error} />
        {invitation.data ? (
          <>
            <div className="alert info">
              You were invited as <b>{invitation.data.invitation.role}</b> with{' '}
              <b>{invitation.data.invitation.email}</b>.
            </div>
            <ErrorNote error={accept.error} />
            <Field label="Your name" error={fieldError(accept.error, 'name')}>
              <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            </Field>
            <Field
              label="Password"
              hint="At least 12 characters."
              error={fieldError(accept.error, 'password')}
            >
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={12}
              />
            </Field>
            <Field label="Repeat password" error={mismatch ? 'The passwords differ.' : undefined}>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </Field>
            <button className="btn primary" disabled={accept.isPending || mismatch}>
              {accept.isPending ? <Spinner /> : null} Create account
            </button>
          </>
        ) : null}
      </form>
    </div>
  );
}

export function ChangePasswordPage() {
  const me = useMe();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const change = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['me'] });
      navigate('/', { replace: true });
    },
  });
  const forced = me.data?.mustChangePassword;
  const mismatch = confirm.length > 0 && confirm !== next;
  return (
    <div className={forced ? 'auth-page' : ''}>
      <form
        className="card auth-card stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!mismatch) change.mutate();
        }}
      >
        {forced ? <Brand /> : null}
        <h2>Change your password</h2>
        {forced ? (
          <div className="alert warning">
            This is your first sign-in. Choose your own password to continue.
          </div>
        ) : null}
        <ErrorNote error={change.error} />
        <Field label="Current password">
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </Field>
        <Field
          label="New password"
          hint="At least 12 characters."
          error={fieldError(change.error, 'newPassword')}
        >
          <input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
            minLength={12}
          />
        </Field>
        <Field label="Repeat new password" error={mismatch ? 'The passwords differ.' : undefined}>
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </Field>
        <button className="btn primary" disabled={change.isPending || mismatch}>
          {change.isPending ? <Spinner /> : null} Save password
        </button>
      </form>
    </div>
  );
}
