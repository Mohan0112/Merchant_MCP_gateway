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
  /** The URL resolves to a private, loopback or link-local address (SSRF guard). */
  'BLOCKED',
  'DNS',
  'CONNECTION_REFUSED',
  'TIMEOUT',
  'TLS',
  'AUTH',
  'HTTP_ERROR',
  'PROTOCOL',
]);
export type UnreachableReason = z.infer<typeof UnreachableReasonSchema>;

export const ToolReviewSchema = z.enum(['approved', 'changed', 'new']);
export type ToolReview = z.infer<typeof ToolReviewSchema>;

export const ToolInfoSchema = z.object({
  name: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  inputSchema: z.unknown(),
  annotations: z.unknown().nullable(),
  /** Definition pinning: only approved tools are exposed; changed and new ones wait for an admin. */
  review: ToolReviewSchema,
  /** For a changed tool: what was approved before, to compare. */
  approved: z.object({ description: z.string().nullable(), inputSchema: z.unknown() }).nullable(),
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
  /** Tools whose definition changed or appeared since an admin approved the server's tools. */
  pendingToolCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Server = z.infer<typeof ServerSchema>;

/** Approve the current definition of the named tools, or of every tool awaiting review. */
export const ApproveToolsRequestSchema = z.object({
  names: z.array(z.string().min(1).max(200)).min(1).max(500).optional(),
});
export type ApproveToolsRequest = z.infer<typeof ApproveToolsRequestSchema>;

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

// ---------- Tool permissions ----------

/** A server slug or '*' for every server. */
const PolicyServerSchema = z.union([z.literal('*'), SlugSchema]);
/** An upstream tool name, with '*' as a wildcard: 'create_*', 'list_orders', '*'. */
const ToolPatternSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_*.-]{1,128}$/, "Use a tool name, with * as a wildcard (e.g. create_*)");

export const PolicySchema = z.object({
  id: z.uuid(),
  subjectType: z.enum(['role', 'user']),
  role: RoleSchema.nullable(),
  userId: z.uuid().nullable(),
  userEmail: z.string().nullable(),
  server: z.string(),
  tool: z.string(),
  /** 'writes': only tools that aren't marked read-only (MCP readOnlyHint). */
  scope: z.enum(['all', 'writes']),
  effect: z.enum(['allow', 'deny']),
  note: z.string().nullable(),
  createdAt: z.string(),
});
export type Policy = z.infer<typeof PolicySchema>;

export const CreatePolicyRequestSchema = z
  .object({
    subjectType: z.enum(['role', 'user']),
    role: RoleSchema.optional(),
    userId: z.uuid().optional(),
    server: PolicyServerSchema.default('*'),
    tool: ToolPatternSchema.default('*'),
    scope: z.enum(['all', 'writes']).default('all'),
    effect: z.enum(['allow', 'deny']),
    note: z.string().trim().max(200).optional(),
  })
  .refine((p) => (p.subjectType === 'role' ? p.role : p.userId), {
    message: 'Choose the role or the user the rule applies to',
    path: ['subjectType'],
  });
export type CreatePolicyRequest = z.input<typeof CreatePolicyRequestSchema>;

/** One tool as a particular user may (or may not) use it, and the rule that decided. */
export const EffectiveToolSchema = z.object({
  name: z.string(),
  server: z.string(),
  tool: z.string(),
  readOnly: z.boolean(),
  allowed: z.boolean(),
  /** The deciding rule; null when no rule matched (allowed by default). */
  policyId: z.uuid().nullable(),
});
export type EffectiveTool = z.infer<typeof EffectiveToolSchema>;

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
  /** The signed approval of a change the assistant proposed (from a confirmation.required event). */
  approval: z.string().min(1).max(16_384).optional(),
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
  | {
      /** The assistant wants to run a tool that changes data; the user approves or cancels it. */
      type: 'confirmation.required';
      callId: string;
      name: string;
      server: string;
      arguments: unknown;
      /** What the assistant said about the change, if anything. */
      note: string;
      /** Signed, single-use and short-lived; sent back as ChatRequest.approval to run the call. */
      approval: string;
    }
  /** A guardrail stepped in: a message was refused, or secrets were removed from an answer. */
  | { type: 'guardrail'; code: string; message: string }
  | { type: 'message'; text: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; iterations: number; toolCalls: number; provider: string | null };

// ---------- Settings ----------

/** What the chat assistant is told about the business (policies, catalogue, tone). Admin-editable. */
export const AssistantSettingsSchema = z.object({
  context: z.string(),
  /** "default" until an admin saves their own text (an empty save restores the default). */
  source: z.enum(['default', 'custom']),
  updatedAt: z.string().nullable(),
});
export type AssistantSettings = z.infer<typeof AssistantSettingsSchema>;

export const UpdateAssistantSettingsSchema = z.object({
  context: z.string().trim().max(6000),
});
export type UpdateAssistantSettings = z.infer<typeof UpdateAssistantSettingsSchema>;
