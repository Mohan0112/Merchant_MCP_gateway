import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { RequireAdmin, RequireUser } from './auth';
import { Spinner } from './components/ui';
import { Layout } from './components/Layout';
import { ApiError } from './lib/api';
import { AssistantPage } from './pages/AssistantPage';
import { AcceptInvitePage, ChangePasswordPage, LoginPage } from './pages/AuthPages';
import { AuditPage } from './pages/AuditPage';
import { KeysPage } from './pages/KeysPage';
import { MembersPage } from './pages/MembersPage';
import { ServersPage } from './pages/ServersPage';
import './styles.css';

// The chat page brings the Markdown renderer; load it only when someone opens the chat.
const ChatPage = lazy(() => import('./pages/ChatPage').then((m) => ({ default: m.ChatPage })));

// A 401 on any call means the session ended (signed out elsewhere, expired, or disabled):
// forget the user so the router sends them to the sign-in page.
const onError = (error: unknown) => {
  if (error instanceof ApiError && error.status === 401) queryClient.setQueryData(['me'], null);
};
const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      retry: (failures, error) =>
        !(error instanceof ApiError && error.status < 500) && failures < 2,
      refetchOnWindowFocus: true,
    },
  },
});

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/invite/:token', element: <AcceptInvitePage /> },
  {
    element: (
      <RequireUser>
        <Layout />
      </RequireUser>
    ),
    children: [
      { path: '/', element: <ServersPage /> },
      {
        path: '/chat',
        element: (
          <Suspense fallback={<Spinner />}>
            <ChatPage />
          </Suspense>
        ),
      },
      { path: '/keys', element: <KeysPage /> },
      { path: '/audit', element: <AuditPage /> },
      {
        path: '/members',
        element: (
          <RequireAdmin>
            <MembersPage />
          </RequireAdmin>
        ),
      },
      {
        path: '/assistant',
        element: (
          <RequireAdmin>
            <AssistantPage />
          </RequireAdmin>
        ),
      },
    ],
  },
  {
    path: '/change-password',
    element: (
      <RequireUser>
        <ChangePasswordPage />
      </RequireUser>
    ),
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
