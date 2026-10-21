import type { CreatePolicyRequest, Policy, Role } from '@ahjin/contracts';
import { and, asc, eq, or } from 'drizzle-orm';
import type { GatewayContext } from '../../context';
import { toolPolicies, users } from '../../db/schema';
import { notFound } from '../../lib/errors';

type PolicyRow = typeof toolPolicies.$inferSelect;

/** A tool as permissions see it: which server, which upstream tool, and whether it only reads. */
export interface PolicyTarget {
  slug: string;
  tool: string;
  readOnly: boolean;
}

export interface Decision {
  allowed: boolean;
  /** The rule that decided, or null when none matched (allowed by default). */
  rule: PolicyRow | null;
}

function pattern(glob: string): RegExp {
  const escaped = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

const applies = (rule: PolicyRow, target: PolicyTarget) =>
  (rule.serverSlug === '*' || rule.serverSlug === target.slug) &&
  pattern(rule.toolPattern).test(target.tool) &&
  (rule.scope === 'all' || !target.readOnly);

/**
 * The rules for one user, loaded once per request and then asked about many tools. A user's own
 * rules are more specific than their role's, so they're consulted first; at the same level a
 * deny beats an allow. With no matching rule, a tool is allowed (the core behaviour).
 */
export class PermissionSet {
  constructor(
    private readonly ownRules: PolicyRow[],
    private readonly roleRules: PolicyRow[],
  ) {}

  decide(target: PolicyTarget): Decision {
    for (const rules of [this.ownRules, this.roleRules]) {
      const matching = rules.filter((rule) => applies(rule, target));
      const deny = matching.find((rule) => rule.effect === 'deny');
      if (deny) return { allowed: false, rule: deny };
      const allow = matching.find((rule) => rule.effect === 'allow');
      if (allow) return { allowed: true, rule: allow };
    }
    return { allowed: true, rule: null };
  }
}

const toDto = (row: PolicyRow, email: string | null): Policy => ({
  id: row.id,
  subjectType: row.subjectType,
  role: row.role,
  userId: row.userId,
  userEmail: email,
  server: row.serverSlug,
  tool: row.toolPattern,
  scope: row.scope,
  effect: row.effect,
  note: row.note,
  createdAt: row.createdAt.toISOString(),
});

/** Tool permissions: storage, and the PermissionSet of a user. */
export class ToolPolicies {
  constructor(private readonly ctx: GatewayContext) {}

  async for(subject: { userId: string; role: Role }): Promise<PermissionSet> {
    const rows = await this.ctx.db
      .select()
      .from(toolPolicies)
      .where(
        or(
          eq(toolPolicies.userId, subject.userId),
          and(eq(toolPolicies.subjectType, 'role'), eq(toolPolicies.role, subject.role)),
        ),
      )
      .orderBy(asc(toolPolicies.createdAt));
    return new PermissionSet(
      rows.filter((r) => r.subjectType === 'user'),
      rows.filter((r) => r.subjectType === 'role'),
    );
  }

  async list(): Promise<Policy[]> {
    const rows = await this.ctx.db
      .select({ policy: toolPolicies, email: users.email })
      .from(toolPolicies)
      .leftJoin(users, eq(users.id, toolPolicies.userId))
      .orderBy(asc(toolPolicies.createdAt));
    return rows.map(({ policy, email }) => toDto(policy, email));
  }

  async create(actorId: string, input: CreatePolicyRequest): Promise<Policy> {
    let email: string | null = null;
    if (input.subjectType === 'user') {
      const [user] = await this.ctx.db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, input.userId!))
        .limit(1);
      if (!user) throw notFound('User');
      email = user.email;
    }
    const [row] = await this.ctx.db
      .insert(toolPolicies)
      .values({
        subjectType: input.subjectType,
        role: input.subjectType === 'role' ? input.role! : null,
        userId: input.subjectType === 'user' ? input.userId! : null,
        serverSlug: input.server ?? '*',
        toolPattern: input.tool ?? '*',
        scope: input.scope ?? 'all',
        effect: input.effect,
        note: input.note || null,
        createdBy: actorId,
      })
      .returning();
    return toDto(row!, email);
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.ctx.db
      .delete(toolPolicies)
      .where(eq(toolPolicies.id, id))
      .returning({ id: toolPolicies.id });
    if (!deleted.length) throw notFound('Rule');
  }
}
