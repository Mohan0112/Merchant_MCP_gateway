import type { PolicyTarget, ToolPolicies } from '../modules/policies/service';
import type { CatalogTool } from './catalog';
import type { CallGuard, CallRequest, Rejection } from './invoke';

export const policyTarget = (tool: CatalogTool): PolicyTarget => ({
  slug: tool.slug,
  tool: tool.originalName,
  readOnly: tool.definition.annotations?.readOnlyHint === true,
});

/**
 * Tool permissions on tools/call. tools/list already hides what a user may not use; this refuses
 * a direct call to a hidden tool anyway (a client can guess names, or cache an old list).
 */
export class PolicyGuard implements CallGuard {
  constructor(private readonly policies: ToolPolicies) {}

  async check(call: CallRequest, tool: CatalogTool): Promise<Rejection | null> {
    const permissions = await this.policies.for(call.principal);
    const { allowed, rule } = permissions.decide(policyTarget(tool));
    if (allowed) return null;
    const why = rule?.note ? ` (${rule.note})` : '';
    return {
      outcome: 'denied_policy',
      message: `You are not allowed to use ${call.name}${why}. Tool permissions are managed by an admin.`,
    };
  }
}
