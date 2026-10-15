import { z } from 'zod';
import { RoleSchema } from './enums';

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
