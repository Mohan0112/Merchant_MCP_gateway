import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Schema v1 (plan §8.6). Secrets are never stored in clear text: passwords and tokens as hashes,
// upstream credentials as AES-256-GCM ciphertext.

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const at = (name: string) => timestamp(name, { withTimezone: true });

export const userRole = pgEnum('user_role', ['admin', 'member']);
export const userStatus = pgEnum('user_status', ['active', 'disabled']);
export const upstreamAuthType = pgEnum('upstream_auth_type', ['none', 'bearer', 'header']);
export const auditChannel = pgEnum('audit_channel', ['mcp_client', 'chat_agent']);
export const auditOutcome = pgEnum('audit_outcome', [
  'success',
  'tool_error',
  'timeout',
  'upstream_unreachable',
  'rejected_disabled',
  'denied_auth',
  'denied_policy',
  'not_found',
]);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull().default('member'),
    status: userStatus('status').notNull().default('active'),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    createdAt: at('created_at').notNull().defaultNow(),
    lastLoginAt: at('last_login_at'),
  },
  (t) => [uniqueIndex('users_email_lower_unique').on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: at('created_at').notNull().defaultNow(),
    lastSeenAt: at('last_seen_at').notNull().defaultNow(),
    expiresAt: at('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const invitations = pgTable('invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  role: userRole('role').notNull().default('member'),
  tokenHash: text('token_hash').notNull().unique(),
  invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: at('created_at').notNull().defaultNow(),
  expiresAt: at('expires_at').notNull(),
  acceptedAt: at('accepted_at'),
  revokedAt: at('revoked_at'),
});

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Non-secret lookup prefix, shown in the UI. */
    prefix: text('prefix').notNull().unique(),
    /** HMAC-SHA256 of the full key with a server-side pepper. */
    keyHash: text('key_hash').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: at('created_at').notNull().defaultNow(),
    lastUsedAt: at('last_used_at'),
    expiresAt: at('expires_at'),
    revokedAt: at('revoked_at'),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('api_keys_user_idx').on(t.userId)],
);

export const upstreamServers = pgTable('upstream_servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Tool-name prefix (slug__tool); immutable after creation (ADR-003). */
  slug: text('slug').notNull().unique(),
  displayName: text('display_name').notNull(),
  url: text('url').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  authType: upstreamAuthType('auth_type').notNull().default('none'),
  authHeaderName: text('auth_header_name'),
  credentialCiphertext: bytea('credential_ciphertext'),
  credentialIv: bytea('credential_iv'),
  credentialTag: bytea('credential_tag'),
  timeoutMs: integer('timeout_ms').notNull().default(30_000),
  seeded: boolean('seeded').notNull().default(false),
  lastStatus: text('last_status'),
  lastError: text('last_error'),
  lastCheckedAt: at('last_checked_at'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

export const upstreamTools = pgTable(
  'upstream_tools',
  {
    serverId: uuid('server_id')
      .notNull()
      .references(() => upstreamServers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    title: text('title'),
    description: text('description'),
    inputSchema: jsonb('input_schema'),
    outputSchema: jsonb('output_schema'),
    annotations: jsonb('annotations'),
    /** Hash of the definition, used by Phase 2 tool pinning. */
    definitionHash: text('definition_hash'),
    fetchedAt: at('fetched_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.name] })],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    occurredAt: at('occurred_at').notNull().defaultNow(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    channel: auditChannel('channel').notNull(),
    serverId: uuid('server_id').references(() => upstreamServers.id, { onDelete: 'set null' }),
    /** Kept after the server is deleted, so history stays readable. */
    serverSlug: text('server_slug'),
    toolName: text('tool_name'),
    durationMs: integer('duration_ms'),
    outcome: auditOutcome('outcome').notNull(),
    errorMessage: text('error_message'),
    requestId: text('request_id'),
  },
  (t) => [
    index('audit_logs_occurred_idx').on(t.occurredAt.desc()),
    index('audit_logs_user_idx').on(t.userId, t.occurredAt.desc()),
    index('audit_logs_server_idx').on(t.serverId, t.occurredAt.desc()),
  ],
);

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: at('updated_at').notNull().defaultNow(),
});
