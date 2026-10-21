import { z } from 'zod';

/**
 * Upstream server slug. It becomes the tool-name prefix (`slug__tool`), so it must never
 * contain "_" — that keeps splitting on the first "__" unambiguous (ADR-003).
 */
export const SlugSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{1,19}$/,
    'Use 2-20 lowercase letters, digits or dashes, starting with a letter',
  );
export type Slug = z.infer<typeof SlugSchema>;

export const RoleSchema = z.enum(['admin', 'member']);
export type Role = z.infer<typeof RoleSchema>;

export const UpstreamAuthTypeSchema = z.enum(['none', 'bearer', 'header']);
export type UpstreamAuthType = z.infer<typeof UpstreamAuthTypeSchema>;

export const UpstreamStatusSchema = z.enum(['connecting', 'connected', 'unreachable', 'disabled']);
export type UpstreamStatus = z.infer<typeof UpstreamStatusSchema>;

export const AuditChannelSchema = z.enum(['mcp_client', 'chat_agent']);
export type AuditChannel = z.infer<typeof AuditChannelSchema>;

export const AuditOutcomeSchema = z.enum([
  'success',
  'tool_error',
  'timeout',
  'upstream_unreachable',
  'rejected_disabled',
  'denied_auth',
  'denied_policy',
  'not_found',
  'pending_review',
]);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

/**
 * Gateway API key: `amcp_` + 8-character lookup prefix + `_` + 43-character base64url secret
 * (32 random bytes). The `amcp_` marker lets secret scanners recognise leaked keys.
 */
export const API_KEY_PATTERN = /^amcp_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

/** Returns the non-secret lookup prefix of a well-formed key, or null. */
export function apiKeyPrefix(rawKey: string): string | null {
  return API_KEY_PATTERN.exec(rawKey)?.[1] ?? null;
}
