import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createLogger } from '@ahjin/logger';
import http from 'node:http';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { createMcpHttpServer, type McpHttpServer } from './server';
import { defineTool, ToolError } from './tool';

const TOKEN = 'test-token';
const quietLogger = createLogger('test', {
  destination: new Writable({ write: (_chunk, _enc, cb) => cb() }),
});

const add = defineTool({
  name: 'add',
  description: 'Adds two numbers',
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  outputSchema: z.object({ sum: z.number() }),
  annotations: { readOnlyHint: true },
  execute: async ({ a, b }) => ({ sum: a + b }),
});
const expectedFailure = defineTool({
  name: 'find_order',
  description: 'Always reports a missing order',
  inputSchema: z.object({ id: z.number() }),
  execute: async ({ id }) => {
    throw new ToolError(`Order ${id} not found`);
  },
});
const crash = defineTool({
  name: 'crash',
  description: 'Throws an unexpected error',
  inputSchema: z.object({}),
  execute: async () => {
    throw new Error('database password is hunter2');
  },
});

let server: McpHttpServer;
let baseUrl: string;
let ready = true;

beforeAll(async () => {
  server = createMcpHttpServer({
    name: 'kit-test',
    version: '1.2.3',
    tools: [add, expectedFailure, crash],
    credential: { type: 'bearer', token: TOKEN },
    allowedHosts: ['127.0.0.1', 'localhost'],
    info: () => ({ region: 'test' }),
    readiness: () => ready,
    logger: quietLogger,
  });
  await server.listen(0, '127.0.0.1');
  const address = server.app.server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await server.close();
});

async function connect(token = TOKEN) {
  const client = new Client(
    { name: 'kit-test-client', version: '0.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

const text = (result: { content?: unknown }) =>
  ((result.content as Array<{ text?: string }>) ?? []).map((c) => c.text).join('');

describe('createMcpHttpServer', () => {
  it('lists the registered tools plus the shared server_info tool', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['add', 'crash', 'find_order', 'server_info']);
    await client.close();
  });

  it('returns structured output for a successful call', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'add', arguments: { a: 2, b: 3 } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ sum: 5 });
    await client.close();
  });

  it('returns ToolError messages to the caller as isError results', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'find_order', arguments: { id: 999 } });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Order 999 not found');
    await client.close();
  });

  it('hides the details of unexpected errors', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'crash', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^crash failed unexpectedly \(incident [0-9a-f-]+\)\.$/);
    expect(text(result)).not.toContain('hunter2');
    await client.close();
  });

  it('includes extra fields in server_info', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'server_info', arguments: {} });
    expect(result.structuredContent).toEqual({
      name: 'kit-test',
      version: '1.2.3',
      region: 'test',
    });
    await client.close();
  });

  it('rejects a wrong credential with 401', async () => {
    await expect(connect('wrong-token')).rejects.toMatchObject({ status: 401 });
  });

  it('rejects requests for a host that is not allowed (DNS rebinding protection)', async () => {
    // node:http, because fetch() treats Host as a forbidden header and ignores the override.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const req = http.request(
        `${baseUrl}/mcp`,
        {
          method: 'POST',
          headers: {
            Host: 'evil.example.com',
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    expect(status).toBe(403);
  });

  it('serves liveness and readiness', async () => {
    expect((await fetch(`${baseUrl}/livez`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(200);
    ready = false;
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(503);
    ready = true;
  });
});
