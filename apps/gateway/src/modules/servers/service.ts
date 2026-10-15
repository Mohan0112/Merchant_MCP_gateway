import type {
  CreateServerRequest,
  Server,
  TestConnectionRequest,
  TestConnectionResult,
  ToolInfo,
  UpdateServerRequest,
  UpstreamStatus,
} from '@urumi/contracts';
import { asc, count, eq } from 'drizzle-orm';
import type { GatewayContext } from '../../context';
import { upstreamServers, upstreamTools } from '../../db/schema';
import { encryptSecret } from '../../lib/crypto';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { iso } from '../../lib/http';
import type { UpstreamClientFactory, UpstreamTool } from '../../mcp/upstream/client';
import { classifyError } from '../../mcp/upstream/errors';
import { targetFor, type ServerRow, type UpstreamManager } from '../../mcp/upstream/manager';
import type { Principal } from '../auth/principal';

export interface ServersDeps {
  ctx: GatewayContext;
  manager: UpstreamManager;
  factory: UpstreamClientFactory;
}

function toToolInfo(tool: UpstreamTool): ToolInfo {
  return {
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations ?? null,
  };
}

/** Status for the dashboard: live state if connected, otherwise what we know. Credentials never leave. */
function toServerDto(
  deps: ServersDeps,
  row: ServerRow,
  viewer: Principal,
  storedToolCount: number,
): Server {
  const state = deps.manager.state(row.id);
  const status: UpstreamStatus = !row.enabled ? 'disabled' : (state?.status ?? 'connecting');
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    url: viewer.role === 'admin' ? row.url : null,
    enabled: row.enabled,
    authType: row.authType,
    authHeaderName: viewer.role === 'admin' ? row.authHeaderName : null,
    hasCredential: Boolean(row.credentialCiphertext),
    timeoutMs: row.timeoutMs,
    seeded: row.seeded,
    status,
    statusReason: status === 'unreachable' ? (state?.reason ?? null) : null,
    statusMessage: status === 'unreachable' ? (state?.message ?? null) : null,
    statusSince: state ? state.since.toISOString() : null,
    lastCheckedAt: iso(state?.lastCheckedAt ?? row.lastCheckedAt),
    protocolEra: state?.era ?? null,
    toolCount: state?.status === 'connected' ? state.tools.length : storedToolCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function storedToolCounts(ctx: GatewayContext): Promise<Map<string, number>> {
  const rows = await ctx.db
    .select({ serverId: upstreamTools.serverId, total: count() })
    .from(upstreamTools)
    .groupBy(upstreamTools.serverId);
  return new Map(rows.map((r) => [r.serverId, r.total]));
}

async function findRow(ctx: GatewayContext, id: string): Promise<ServerRow> {
  const [row] = await ctx.db
    .select()
    .from(upstreamServers)
    .where(eq(upstreamServers.id, id))
    .limit(1);
  if (!row) throw notFound('Server');
  return row;
}

export async function listServers(deps: ServersDeps, viewer: Principal): Promise<Server[]> {
  const rows = await deps.ctx.db
    .select()
    .from(upstreamServers)
    .orderBy(asc(upstreamServers.createdAt));
  const counts = await storedToolCounts(deps.ctx);
  return rows.map((row) => toServerDto(deps, row, viewer, counts.get(row.id) ?? 0));
}

/** One server plus its tools: live when connected, otherwise the last known list. */
export async function getServer(deps: ServersDeps, viewer: Principal, id: string) {
  const row = await findRow(deps.ctx, id);
  const state = deps.manager.state(id);
  let tools: ToolInfo[];
  if (state?.status === 'connected') tools = state.tools.map(toToolInfo);
  else {
    const stored = await deps.ctx.db
      .select()
      .from(upstreamTools)
      .where(eq(upstreamTools.serverId, id));
    tools = stored.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    }));
  }
  return { server: toServerDto(deps, row, viewer, tools.length), tools };
}

function sealCredential(ctx: GatewayContext, credential: string) {
  const sealed = encryptSecret(credential, ctx.settings.credentialKey);
  return {
    credentialCiphertext: sealed.ciphertext,
    credentialIv: sealed.iv,
    credentialTag: sealed.tag,
  };
}

const NO_CREDENTIAL = { credentialCiphertext: null, credentialIv: null, credentialTag: null };

export async function createServer(
  deps: ServersDeps,
  actor: Principal,
  input: CreateServerRequest,
): Promise<Server> {
  const [existing] = await deps.ctx.db
    .select({ id: upstreamServers.id })
    .from(upstreamServers)
    .where(eq(upstreamServers.slug, input.slug))
    .limit(1);
  if (existing) throw conflict(`A server with slug "${input.slug}" already exists.`);

  const [row] = await deps.ctx.db
    .insert(upstreamServers)
    .values({
      slug: input.slug,
      displayName: input.displayName,
      url: input.url,
      enabled: input.enabled,
      timeoutMs: input.timeoutMs,
      authType: input.authType,
      authHeaderName: input.authType === 'header' ? (input.authHeaderName ?? null) : null,
      ...(input.authType !== 'none' && input.credential
        ? sealCredential(deps.ctx, input.credential)
        : NO_CREDENTIAL),
      createdBy: actor.userId,
    })
    .returning();
  await deps.manager.reload(row!.id);
  return toServerDto(deps, row!, actor, 0);
}

/** Partial update. A new credential replaces the stored one; switching to "none" erases it. */
export async function updateServer(
  deps: ServersDeps,
  actor: Principal,
  id: string,
  input: UpdateServerRequest,
): Promise<Server> {
  const row = await findRow(deps.ctx, id);
  const authType = input.authType ?? row.authType;
  const authHeaderName =
    authType === 'header' ? (input.authHeaderName ?? row.authHeaderName) : null;
  if (authType === 'header' && !authHeaderName)
    throw badRequest('A header name is required for header credentials.');

  let credentialColumns = {};
  if (authType === 'none') credentialColumns = NO_CREDENTIAL;
  else if (input.credential) credentialColumns = sealCredential(deps.ctx, input.credential);
  else if (!row.credentialCiphertext)
    throw badRequest('A credential is required for this auth type.');

  const [updated] = await deps.ctx.db
    .update(upstreamServers)
    .set({
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      authType,
      authHeaderName,
      ...credentialColumns,
      updatedAt: deps.ctx.now(),
    })
    .where(eq(upstreamServers.id, id))
    .returning();
  await deps.manager.reload(id);
  const counts = await storedToolCounts(deps.ctx);
  return toServerDto(deps, updated!, actor, counts.get(id) ?? 0);
}

export async function deleteServer(deps: ServersDeps, id: string): Promise<void> {
  await findRow(deps.ctx, id);
  await deps.ctx.db.delete(upstreamServers).where(eq(upstreamServers.id, id));
  await deps.manager.remove(id);
}

export async function refreshServer(
  deps: ServersDeps,
  actor: Principal,
  id: string,
): Promise<Server> {
  await findRow(deps.ctx, id);
  await deps.manager.reload(id);
  return (await getServer(deps, actor, id)).server;
}

/** Tries a URL and credential without saving anything; the credential is used once and dropped. */
export async function testConnection(
  deps: ServersDeps,
  input: TestConnectionRequest,
): Promise<TestConnectionResult> {
  const pseudoRow = {
    url: input.url,
    authType: input.authType,
    authHeaderName: input.authHeaderName ?? null,
    credentialCiphertext: null,
    credentialIv: null,
    credentialTag: null,
  } as unknown as ServerRow;
  const target = targetFor(pseudoRow, deps.ctx.settings.credentialKey);
  if (input.credential) {
    if (input.authType === 'bearer') target.headers.Authorization = `Bearer ${input.credential}`;
    if (input.authType === 'header' && input.authHeaderName)
      target.headers[input.authHeaderName] = input.credential;
  }
  const client = deps.factory(target, () => {});
  const started = Date.now();
  try {
    const { era } = await client.connect(input.timeoutMs);
    const tools = await client.listTools(input.timeoutMs);
    return {
      ok: true,
      latencyMs: Date.now() - started,
      protocolEra: era,
      tools: tools.map((t) => t.name),
    };
  } catch (error) {
    return { ok: false, ...classifyError(error) };
  } finally {
    await client.close();
  }
}
