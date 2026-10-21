import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  createMcpHttpServer,
  defineTool,
  ToolError,
  type McpHttpServer,
  type StaticCredential,
} from '@ahjin/mcp-kit';
import * as z from 'zod';
import { bootstrapAdmin } from '../modules/auth/users';
import { Browser, quietLogger, type Harness } from './harness';

const echo = defineTool({
  name: 'echo',
  title: 'Echo',
  description: 'Returns the text it was given.',
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  annotations: { readOnlyHint: true },
  execute: async ({ text }) => ({ text }),
});

const fail = defineTool({
  name: 'fail',
  description: 'Always fails with a readable error.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true },
  execute: async () => {
    throw new ToolError('Order 999 not found');
  },
});

const slow = defineTool({
  name: 'slow',
  description: 'Answers after the given delay.',
  inputSchema: z.object({ ms: z.number().int() }),
  annotations: { readOnlyHint: true },
  execute: async ({ ms }) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { waited: ms };
  },
});

/** A change that can't be undone: the chat agent asks the user before running it. */
const cancelOrder = defineTool({
  name: 'cancel_order',
  description: 'Cancels an order.',
  inputSchema: z.object({ id: z.number().int() }),
  outputSchema: z.object({ id: z.number(), status: z.string() }),
  annotations: { readOnlyHint: false, destructiveHint: true },
  execute: async ({ id }) => ({ id, status: 'cancelled' }),
});

export interface TestUpstream {
  server: McpHttpServer;
  url: string;
  close(): Promise<void>;
}

/** A real MCP server (the same kit our woo-mcp and fx-mcp use) on a random loopback port. */
export async function startUpstream(
  name: string,
  credential: StaticCredential,
  port = 0,
): Promise<TestUpstream> {
  const server = createMcpHttpServer({
    name,
    version: '1.0.0',
    tools: [echo, fail, slow, cancelOrder],
    credential,
    allowedHosts: ['127.0.0.1', 'localhost'],
    logger: quietLogger,
    closeGraceMs: 200,
  });
  const base = await server.listen(port, '127.0.0.1');
  return { server, url: `${base}/mcp`, close: () => server.close() };
}

export interface Team {
  admin: Browser;
  member: Browser;
  memberId: string;
}

/** An admin who has set their own password, and an invited member. */
export async function createTeam(h: Harness): Promise<Team> {
  await bootstrapAdmin(h.ctx, 'admin@ahjin.test', 'initial-admin-password');
  const admin = new Browser(h.app);
  await admin.login('admin@ahjin.test', 'initial-admin-password');
  await admin.request('POST', '/api/auth/password', {
    currentPassword: 'initial-admin-password',
    newPassword: 'a-new-admin-password',
  });
  const invite = await admin.request('POST', '/api/invitations', { email: 'bob@ahjin.test' });
  const token = new URL(invite.json().invitation.link).pathname.split('/').pop()!;
  const member = new Browser(h.app);
  const accepted = await member.request('POST', `/api/invitations/accept/${token}`, {
    name: 'Bob',
    password: 'bobs-long-password',
  });
  return { admin, member, memberId: accepted.json().user.id };
}

/** An MCP client (like Claude Code) talking to the gateway over real HTTP with an API key. */
export async function connectClient(
  baseUrl: string,
  apiKey: string,
  onToolsChanged?: () => void,
): Promise<Client> {
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    {
      versionNegotiation: { mode: 'auto' },
      ...(onToolsChanged ? { listChanged: { tools: { onChanged: () => onToolsChanged() } } } : {}),
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
    }),
  );
  return client;
}
