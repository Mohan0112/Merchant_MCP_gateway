import type {
  ApiKey,
  AssistantSettings,
  AuditEntry,
  AuditQuery,
  CreateApiKeyRequest,
  CreatedApiKey,
  CreateServerRequest,
  Invitation,
  Role,
  Server,
  TestConnectionRequest,
  TestConnectionResult,
  ToolInfo,
  UpdateServerRequest,
  User,
} from '@ahjin/contracts';

export interface FieldError {
  field: string;
  message: string;
}

/** An RFC 9457 problem returned by the gateway, with field errors for forms. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: FieldError[] = [],
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Every call goes to the same origin with the session cookie. Writes carry X-Requested-With, which
 * the gateway requires on non-GET requests as its cross-site request forgery check.
 */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(method !== 'GET' ? { 'X-Requested-With': 'fetch' } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      typeof data.code === 'string' ? data.code : 'error',
      typeof data.detail === 'string' ? data.detail : `Request failed (HTTP ${res.status}).`,
      Array.isArray(data.errors) ? (data.errors as FieldError[]) : [],
      typeof data.requestId === 'string' ? data.requestId : undefined,
    );
  }
  return data as T;
}

export interface InvitationPreview {
  email: string;
  role: Role;
  expiresAt: string;
}

export interface AuditPage {
  entries: AuditEntry[];
  nextCursor: number | null;
}

const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const api = {
  me: () => request<{ user: User }>('GET', '/api/auth/me'),
  login: (email: string, password: string) =>
    request<{ user: User }>('POST', '/api/auth/login', { email, password }),
  logout: () => request<void>('POST', '/api/auth/logout'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('POST', '/api/auth/password', { currentPassword, newPassword }),

  describeInvitation: (token: string) =>
    request<{ invitation: InvitationPreview }>('GET', `/api/invitations/accept/${token}`),
  acceptInvitation: (token: string, name: string, password: string) =>
    request<{ user: User }>('POST', `/api/invitations/accept/${token}`, { name, password }),

  users: () => request<{ users: User[] }>('GET', '/api/users'),
  updateUser: (id: string, patch: { role?: Role; status?: 'active' | 'disabled' }) =>
    request<{ user: User }>('PATCH', `/api/users/${id}`, patch),
  invitations: () => request<{ invitations: Invitation[] }>('GET', '/api/invitations'),
  invite: (email: string, role: Role) =>
    request<{ invitation: Invitation & { link: string } }>('POST', '/api/invitations', {
      email,
      role,
    }),
  revokeInvitation: (id: string) => request<void>('DELETE', `/api/invitations/${id}`),

  keys: (userId?: string) =>
    request<{ keys: ApiKey[] }>('GET', `/api/api-keys${query({ userId })}`),
  createKey: (input: CreateApiKeyRequest) =>
    request<{ key: CreatedApiKey }>('POST', '/api/api-keys', input),
  revokeKey: (id: string) => request<{ key: ApiKey }>('DELETE', `/api/api-keys/${id}`),

  servers: () => request<{ servers: Server[] }>('GET', '/api/servers'),
  server: (id: string) =>
    request<{ server: Server; tools: ToolInfo[] }>('GET', `/api/servers/${id}`),
  createServer: (input: CreateServerRequest) =>
    request<{ server: Server }>('POST', '/api/servers', input),
  updateServer: (id: string, input: UpdateServerRequest) =>
    request<{ server: Server }>('PATCH', `/api/servers/${id}`, input),
  deleteServer: (id: string) => request<void>('DELETE', `/api/servers/${id}`),
  refreshServer: (id: string) => request<{ server: Server }>('POST', `/api/servers/${id}/refresh`),
  testServer: (input: TestConnectionRequest) =>
    request<{ result: TestConnectionResult }>('POST', '/api/servers/test', input),

  audit: (filters: Partial<AuditQuery>) =>
    request<AuditPage>('GET', `/api/audit-logs${query({ ...filters })}`),

  assistantSettings: () =>
    request<{ settings: AssistantSettings }>('GET', '/api/settings/assistant'),
  saveAssistantSettings: (context: string) =>
    request<{ settings: AssistantSettings }>('PUT', '/api/settings/assistant', { context }),
};
