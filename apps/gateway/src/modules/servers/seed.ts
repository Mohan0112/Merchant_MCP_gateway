import { UpstreamAuthTypeSchema } from '@urumi/contracts';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import type { GatewayContext } from '../../context';
import { systemSettings, upstreamServers } from '../../db/schema';
import { encryptSecret } from '../../lib/crypto';

export const UpstreamSeedSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  url: z.url(),
  authType: UpstreamAuthTypeSchema.default('none'),
  authHeaderName: z.string().optional(),
  /** Name of the environment variable holding the credential (filled from a Secret by the chart). */
  credentialEnv: z.string().optional(),
  timeoutMs: z.number().int().positive().default(30_000),
});
export type UpstreamSeed = z.infer<typeof UpstreamSeedSchema>;

/**
 * Registers the in-cluster MCP servers (woo, fx) on first boot, so the WooCommerce server is already
 * there when an admin first opens the dashboard. Each seed is applied once: if an admin later
 * deletes it, it stays deleted.
 */
export async function seedUpstreams(
  ctx: GatewayContext,
  seeds: UpstreamSeed[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  for (const seed of seeds) {
    const marker = `seed:${seed.slug}`;
    const [applied] = await ctx.db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, marker))
      .limit(1);
    if (applied) continue;

    const credential = seed.credentialEnv ? env[seed.credentialEnv] : undefined;
    if (seed.authType !== 'none' && !credential) {
      ctx.logger.warn(
        { slug: seed.slug, env: seed.credentialEnv },
        'seed credential missing; server not seeded',
      );
      continue;
    }
    const [existing] = await ctx.db
      .select({ id: upstreamServers.id })
      .from(upstreamServers)
      .where(eq(upstreamServers.slug, seed.slug))
      .limit(1);
    if (!existing) {
      const sealed = credential ? encryptSecret(credential, ctx.settings.credentialKey) : undefined;
      await ctx.db.insert(upstreamServers).values({
        slug: seed.slug,
        displayName: seed.displayName,
        url: seed.url,
        authType: seed.authType,
        authHeaderName: seed.authType === 'header' ? (seed.authHeaderName ?? null) : null,
        credentialCiphertext: sealed?.ciphertext ?? null,
        credentialIv: sealed?.iv ?? null,
        credentialTag: sealed?.tag ?? null,
        timeoutMs: seed.timeoutMs,
        seeded: true,
      });
      ctx.logger.info({ slug: seed.slug, url: seed.url }, 'seeded upstream server');
    }
    await ctx.db
      .insert(systemSettings)
      .values({ key: marker, value: { seededAt: ctx.now().toISOString() } });
  }
}
