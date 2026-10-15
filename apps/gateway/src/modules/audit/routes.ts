import { AuditQuerySchema } from '@urumi/contracts';
import type { FastifyInstance } from 'fastify';
import type { GatewayContext } from '../../context';
import { parse } from '../../lib/http';
import { requireUser } from '../auth/principal';
import { queryAudit } from './service';

export function registerAuditRoutes(app: FastifyInstance, ctx: GatewayContext) {
  app.get('/api/audit-logs', async (request) =>
    queryAudit(ctx, requireUser(request), parse(AuditQuerySchema, request.query)),
  );
}
