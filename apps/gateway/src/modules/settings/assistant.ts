import { UpdateAssistantSettingsSchema, type AssistantSettings } from '@ahjin/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { GatewayContext } from '../../context';
import { systemSettings } from '../../db/schema';
import { parse } from '../../lib/http';
import { requireAdmin } from '../auth/principal';

const KEY = 'assistant.context';

/**
 * What the chat assistant is told about the business: the deployment default (Helm value
 * platform.gateway.chat.context), until an admin saves their own text in the dashboard.
 */
export class AssistantSettingsStore {
  constructor(
    private readonly ctx: GatewayContext,
    private readonly defaultContext: string,
  ) {}

  async get(): Promise<AssistantSettings> {
    const [row] = await this.ctx.db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, KEY))
      .limit(1);
    const custom = (row?.value as { context?: string } | undefined)?.context;
    return custom
      ? { context: custom, source: 'custom', updatedAt: row!.updatedAt.toISOString() }
      : { context: this.defaultContext, source: 'default', updatedAt: null };
  }

  /** An empty text restores the default. */
  async update(context: string): Promise<AssistantSettings> {
    if (!context) {
      await this.ctx.db.delete(systemSettings).where(eq(systemSettings.key, KEY));
    } else {
      const now = this.ctx.now();
      await this.ctx.db
        .insert(systemSettings)
        .values({ key: KEY, value: { context }, updatedAt: now })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: { context }, updatedAt: now },
        });
    }
    return this.get();
  }
}

export function registerSettingsRoutes(app: FastifyInstance, store: AssistantSettingsStore) {
  app.get('/api/settings/assistant', async (request) => {
    requireAdmin(request);
    return { settings: await store.get() };
  });

  app.put('/api/settings/assistant', async (request) => {
    requireAdmin(request);
    const { context } = parse(UpdateAssistantSettingsSchema, request.body);
    return { settings: await store.update(context) };
  });
}
