import { CreatePolicyRequestSchema, type EffectiveTool } from '@ahjin/contracts';
import type { FastifyInstance } from 'fastify';
import * as z from 'zod';
import type { GatewayContext } from '../../context';
import { notFound } from '../../lib/errors';
import { parse } from '../../lib/http';
import type { ToolCatalog } from '../../mcp/catalog';
import { policyTarget } from '../../mcp/policy-guard';
import { requireAdmin, requireUser } from '../auth/principal';
import { findUserById } from '../auth/users';
import type { ToolPolicies } from './service';

export interface PoliciesDeps {
  ctx: GatewayContext;
  policies: ToolPolicies;
  catalog: ToolCatalog;
  /** Tells subscribed MCP clients to list their tools again. */
  onChange: () => void;
}

/** Admins manage rules; anyone can see which tools they themselves may use. */
export function registerPolicyRoutes(app: FastifyInstance, deps: PoliciesDeps) {
  app.get('/api/policies', async (request) => {
    requireAdmin(request);
    return { policies: await deps.policies.list() };
  });

  app.post('/api/policies', async (request, reply) => {
    const actor = requireAdmin(request);
    const policy = await deps.policies.create(
      actor.userId,
      parse(CreatePolicyRequestSchema, request.body),
    );
    deps.onChange();
    return reply.code(201).send({ policy });
  });

  app.delete('/api/policies/:id', async (request, reply) => {
    requireAdmin(request);
    await deps.policies.remove(parse(z.object({ id: z.uuid() }), request.params).id);
    deps.onChange();
    return reply.code(204).send();
  });

  /** Every tool in the catalog, allowed or not for a user (default: the caller), and why. */
  app.get('/api/policies/effective', async (request) => {
    const viewer = requireUser(request);
    const { userId } = parse(z.object({ userId: z.uuid().optional() }), request.query);
    let subject = { userId: viewer.userId, role: viewer.role };
    if (userId && userId !== viewer.userId) {
      requireAdmin(request);
      const user = await findUserById(deps.ctx, userId);
      if (!user) throw notFound('User');
      subject = { userId: user.id, role: user.role };
    }
    const permissions = await deps.policies.for(subject);
    const tools: EffectiveTool[] = deps.catalog.entries().map((tool) => {
      const target = policyTarget(tool);
      const { allowed, rule } = permissions.decide(target);
      return {
        name: tool.definition.name,
        server: tool.slug,
        tool: tool.originalName,
        readOnly: target.readOnly,
        allowed,
        policyId: rule?.id ?? null,
      };
    });
    return { tools };
  });
}
