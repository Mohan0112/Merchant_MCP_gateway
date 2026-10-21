import type { ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { useMe, useSignOut } from '../auth';

const icon = (path: ReactNode) => (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
);

const ICONS = {
  servers: icon(
    <>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>,
  ),
  chat: icon(<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />),
  keys: icon(
    <>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m10.7 12.3 9.3-9.3M17 6l3 3M15 8l2 2" />
    </>,
  ),
  audit: icon(
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </>,
  ),
  assistant: icon(
    <>
      <path d="M12 3 4 6v6c0 4.4 3.4 8.3 8 9 4.6-.7 8-4.6 8-9V6l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>,
  ),
  members: icon(
    <>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 21a7 7 0 0 1 14 0M17 11a3 3 0 1 0 0-6M22 21a6 6 0 0 0-5-5.9" />
    </>,
  ),
};

function Brand() {
  return (
    <div className="brand">
      <img src="/favicon.svg" width="30" height="30" alt="" />
      <div>
        Ahjin
        <small>Team MCP gateway</small>
      </div>
    </div>
  );
}

export { Brand };

export function Layout() {
  const { data: me } = useMe();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const link = ({ isActive }: { isActive: boolean }) => `nav-link ${isActive ? 'active' : ''}`;
  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand />
        <NavLink to="/" end className={link}>
          {ICONS.servers} Servers
        </NavLink>
        <NavLink to="/chat" className={link}>
          {ICONS.chat} Chat
        </NavLink>
        <NavLink to="/keys" className={link}>
          {ICONS.keys} API keys
        </NavLink>
        <NavLink to="/audit" className={link}>
          {ICONS.audit} Audit log
        </NavLink>
        {me?.role === 'admin' ? (
          <>
            <div className="nav-section">Admin</div>
            <NavLink to="/members" className={link}>
              {ICONS.members} Members
            </NavLink>
            <NavLink to="/assistant" className={link}>
              {ICONS.assistant} Assistant
            </NavLink>
          </>
        ) : null}
        <div className="sidebar-footer">
          <div style={{ fontWeight: 600 }}>{me?.name}</div>
          <div className="muted small truncate" title={me?.email}>
            {me?.email}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <span className="badge plain info">{me?.role}</span>
            <NavLink to="/change-password" className="small">
              Password
            </NavLink>
            <button
              type="button"
              className="btn link small"
              onClick={() => {
                void signOut().then(() => navigate('/login'));
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
