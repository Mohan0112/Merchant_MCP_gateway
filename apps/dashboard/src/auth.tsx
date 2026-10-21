import type { User } from '@ahjin/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { Spinner } from './components/ui';
import { api, ApiError } from './lib/api';

/** The signed-in user, or null. A 401 is an answer ("not signed in"), not an error. */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async (): Promise<User | null> => {
      try {
        return (await api.me()).user;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 60_000,
  });
}

export function useSignOut() {
  const client = useQueryClient();
  return async () => {
    await api.logout().catch(() => {});
    client.clear();
    client.setQueryData(['me'], null);
  };
}

function FullPageSpinner() {
  return (
    <div className="auth-page">
      <Spinner />
    </div>
  );
}

/**
 * Pages behind sign-in. A user who must change their password is sent to do that first; the
 * gateway enforces the same rule on every API call.
 */
export function RequireUser({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <FullPageSpinner />;
  if (!me.data) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (me.data.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  return <>{children}</>;
}

/** Admin-only pages. The UI hides them for members; the gateway rejects their API calls anyway. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.data?.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function useIsAdmin(): boolean {
  return useMe().data?.role === 'admin';
}
