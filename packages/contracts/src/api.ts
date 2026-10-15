import { z } from 'zod';
import {
  AuditChannelSchema,
  AuditOutcomeSchema,
  RoleSchema,
  SlugSchema,
  UpstreamAuthTypeSchema,
  UpstreamStatusSchema,
} from './enums';

/** REST API contracts shared by the gateway (validation) and the dashboard (forms and types). */

/** Normalised before validation, so " Asha@Example.com " is accepted and stored as "asha@example.com". */
export const EmailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

/** Long enough to resist guessing; no composition rules (NIST SP 800-63B). */
export const PasswordSchema = z.string().min(12, 'Use at least 12 characters').max(200);

export const UserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  role: RoleSchema,
  status: z.enum(['active', 'disabled']),
  mustChangePassword: z.boolean(),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
});
export type User = z.infer<typeof UserSchema>;

export const LoginRequestSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: PasswordSchema,
});

export const CreateInvitationRequestSchema = z.object({
  email: EmailSchema,
  role: RoleSchema.default('member'),
});
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequestSchema>;

export const InvitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: RoleSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type Invitation = z.infer<typeof InvitationSchema>;

export const AcceptInvitationRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  password: PasswordSchema,
});

export const UpdateUserRequestSchema = z
  .object({ role: RoleSchema.optional(), status: z.enum(['active', 'disabled']).optional() })
  .refine((value) => value.role !== undefined || value.status !== undefined, {
    message: 'Provide role or status',
  });

export const CreateApiKeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** Optional lifetime; omit for a key that lives until revoked. */
  expiresInDays: z.number().int().min(1).max(365).optional(),
  /** Admins may issue a key for another user. */
  userId: z.uuid().optional(),
});
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequestSchema>;

export const ApiKeySchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

/** Returned once, when a key is created. The plaintext key is never retrievable again. */
export const CreatedApiKeySchema = ApiKeySchema.extend({ key: z.string() });
export type CreatedApiKey = z.infer<typeof CreatedApiKeySchema>;

// ---------- Upstream MCP servers (registry) ----------

/** Header names a credential may use; Host and other transport headers are refused. */
const HeaderNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/, 'Use letters, digits and dashes')
  .refine(
    (name) =>
      !['host', 'content-length', 'content-type', 'accept', 'connection'].includes(
        name.toLowerCase(),
      ),
    'This header is reserved',
  );

const UrlSchema = z
  .url()
  .refine((value) => /^https?:\/\//.test(value), 'Use an http:// or https:// URL');

const CredentialFields = {
  authType: UpstreamAuthTypeSchema.default('none'),
  /** Required when authType is "header", e.g. X-API-Key. */
  authHeaderName: HeaderNameSchema.optional(),
  /** Write-only: accepted on create/update, never returned. */
  credential: z.string().min(1).max(4096).optional(),
};

export const CreateServerRequestSchema = z
  .object({
    slug: SlugSchema,
    displayName: z.string().trim().min(1).max(60),
    url: UrlSchema,
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
    ...CredentialFields,
  })
  .refine((s) => s.authType !== 'header' || s.authHeaderName, {
    message: 'A header name is required for header credentials',
    path: ['authHeaderName'],
  })
  .refine((s) => s.authType === 'none' || s.credential, {
    message: 'A credential is required for this auth type',
    path: ['credential'],
  });
export type CreateServerRequest = z.infer<typeof CreateServerRequestSchema>;

/** The slug is immutable (clients cache tool names), so it isn't accepted here. */
export const UpdateServerRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60).optional(),
    url: UrlSchema.optional(),
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().min(1000).max(120_000).optional(),
    authType: UpstreamAuthTypeSchema.optional(),
    authHeaderName: HeaderNameSchema.optional(),
    credential: z.string().min(1).max(4096).optional(),
  })
  .strict();
export type UpdateServerRequest = z.infer<typeof UpdateServerRequestSchema>;

export const TestConnectionRequestSchema = z
  .object({
    url: UrlSchema,
    timeoutMs: z.number().int().min(1000).max(30_000).default(10_000),
    ...CredentialFields,
  })
  .refine((s) => s.authType !== 'header' || s.authHeaderName, {
    message: 'A header name is required for header credentials',
    path: ['authHeaderName'],
  });
export type TestConnectionRequest = z.infer<typeof TestConnectionRequestSchema>;

export const UnreachableReasonSchema = z.enum([
  'DNS',
  'CONNECTION_REFUSED',
  'TIMEOUT',
  'TLS',
  'AUTH',
  'HTTP_ERROR',
  'PROTOCOL',
]);
export type UnreachableReason = z.infer<typeof UnreachableReasonSchema>;

export const ToolInfoSchema = z.object({
  name: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  inputSchema: z.unknown(),
  annotations: z.unknown().nullable(),
});
export type ToolInfo = z.infer<typeof ToolInfoSchema>;

export const ServerSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  displayName: z.string(),
  /** Admins only; null for members (internal addresses aren't shared). */
  url: z.string().nullable(),
  enabled: z.boolean(),
  authType: UpstreamAuthTypeSchema,
  authHeaderName: z.string().nullable(),
  hasCredential: z.boolean(),
  timeoutMs: z.number(),
  seeded: z.boolean(),
  status: UpstreamStatusSchema,
  statusReason: UnreachableReasonSchema.nullable(),
  statusMessage: z.string().nullable(),
  statusSince: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  protocolEra: z.enum(['modern', 'legacy']).nullable(),
  toolCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Server = z.infer<typeof ServerSchema>;

export const TestConnectionResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    latencyMs: z.number(),
    protocolEra: z.enum(['modern', 'legacy']),
    tools: z.array(z.string()),
  }),
  z.object({ ok: z.literal(false), reason: UnreachableReasonSchema, message: z.string() }),
]);
export type TestConnectionResult = z.infer<typeof TestConnectionResultSchema>;

// ---------- Audit log ----------

export const AuditEntrySchema = z.object({
  id: z.number(),
  occurredAt: z.string(),
  userId: z.string().nullable(),
  userEmail: z.string().nullable(),
  userName: z.string().nullable(),
  apiKeyId: z.string().nullable(),
  channel: AuditChannelSchema,
  serverSlug: z.string().nullable(),
  toolName: z.string().nullable(),
  durationMs: z.number().nullable(),
  outcome: AuditOutcomeSchema,
  errorMessage: z.string().nullable(),
  requestId: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const AuditQuerySchema = z.object({
  userId: z.uuid().optional(),
  server: z.string().max(40).optional(),
  tool: z.string().max(120).optional(),
  outcome: AuditOutcomeSchema.optional(),
  channel: AuditChannelSchema.optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  /** Id of the last entry of the previous page (entries are returned newest first). */
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

// ---------- Chat agent ----------

export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(8000),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1).max(40),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/** Server-sent events of one chat turn, in order: tool events, then message, then done (or error). */
export type ChatEvent =
  | { type: 'tool.started'; callId: string; name: string; server: string; arguments: unknown }
  | {
      type: 'tool.completed';
      callId: string;
      name: string;
      ok: boolean;
      durationMs: number;
      preview: string;
    }
  | { type: 'message'; text: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; iterations: number; toolCalls: number; provider: string | null };
