import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { eventually } from '../../test/harness';
import type { UpstreamClientFactory, UpstreamTool } from './client';
import { UpstreamCallFailed, UpstreamConnection, UpstreamUnavailable } from './connection';

const refused = () =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:8080'), { code: 'ECONNREFUSED' }),
  });

/** An upstream we can switch off, slow down or make misbehave. */
class FakeUpstream {
  up = true;
  callMode: 'ok' | 'refused' | 'protocol' = 'ok';
  tools: UpstreamTool[] = [{ name: 'echo', inputSchema: { type: 'object' } }];
  onToolsChanged: ((tools: UpstreamTool[]) => void) | undefined;

  factory: UpstreamClientFactory = (_target, onToolsChanged) => {
    this.onToolsChanged = onToolsChanged;
    return {
      connect: async () => {
        if (!this.up) throw refused();
        return { era: 'modern' as const };
      },
      listTools: async () => {
        if (!this.up) throw refused();
        return this.tools;
      },
      callTool: async (name, args) => {
        if (this.callMode === 'refused' || !this.up) throw refused();
        if (this.callMode === 'protocol')
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'bad arguments');
        return { content: [{ type: 'text', text: JSON.stringify({ name, args }) }] };
      },
      close: async () => {},
    };
  };
}

const OPTIONS = {
  connectTimeoutMs: 500,
  listTimeoutMs: 500,
  healthIntervalMs: 40,
  healthFailureThreshold: 2,
  callFailureThreshold: 3,
  initialBackoffMs: 20,
  maxBackoffMs: 80,
};

let connection: UpstreamConnection | undefined;
afterEach(async () => {
  await connection?.stop();
});

function open(upstream: FakeUpstream, changes: string[] = []) {
  connection = new UpstreamConnection(
    { url: 'http://upstream/mcp', headers: {} },
    upstream.factory,
    (change) => changes.push(`${change}:${connection!.snapshot().status}`),
    OPTIONS,
  );
  connection.start();
  return connection;
}

describe('UpstreamConnection', () => {
  it('connects, lists tools and forwards calls', async () => {
    const upstream = new FakeUpstream();
    const conn = open(upstream);
    await eventually(() => expect(conn.snapshot().status).toBe('connected'));
    expect(conn.snapshot().tools.map((t) => t.name)).toEqual(['echo']);
    expect(conn.snapshot().era).toBe('modern');
    const result = await conn.callTool('echo', { a: 1 }, { timeoutMs: 500 });
    expect(result.content).toEqual([{ type: 'text', text: '{"name":"echo","args":{"a":1}}' }]);
  });

  it('marks a dead upstream unreachable with the reason, then recovers when it is back', async () => {
    const upstream = new FakeUpstream();
    upstream.up = false;
    const conn = open(upstream);
    await eventually(() => expect(conn.snapshot().status).toBe('unreachable'));
    expect(conn.snapshot().reason).toBe('CONNECTION_REFUSED');
    await expect(conn.callTool('echo', {}, { timeoutMs: 500 })).rejects.toBeInstanceOf(
      UpstreamUnavailable,
    );

    upstream.up = true;
    await eventually(() => expect(conn.snapshot().status).toBe('connected'));
    expect(conn.snapshot().reason).toBeNull();
  });

  it('notices an upstream that goes away through health checks', async () => {
    const upstream = new FakeUpstream();
    const changes: string[] = [];
    const conn = open(upstream, changes);
    await eventually(() => expect(conn.snapshot().status).toBe('connected'));
    upstream.up = false;
    await eventually(() => expect(conn.snapshot().status).toBe('unreachable'));
    // Retries don't flap the status between connecting and unreachable.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(changes.filter((c) => c === 'status:unreachable')).toHaveLength(1);
    expect(changes).not.toContain('status:connecting');
  });

  it('reports transport failures of a call and keeps protocol errors as tool errors', async () => {
    const upstream = new FakeUpstream();
    const conn = open(upstream);
    await eventually(() => expect(conn.snapshot().status).toBe('connected'));

    upstream.callMode = 'protocol';
    await expect(conn.callTool('echo', {}, { timeoutMs: 500 })).rejects.toBeInstanceOf(
      ProtocolError,
    );
    expect(conn.snapshot().status).toBe('connected');

    upstream.callMode = 'refused';
    const failure = await conn.callTool('echo', {}, { timeoutMs: 500 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(UpstreamCallFailed);
    expect((failure as UpstreamCallFailed).failure.reason).toBe('CONNECTION_REFUSED');
  });

  it('picks up tool list changes pushed by the upstream', async () => {
    const upstream = new FakeUpstream();
    const changes: string[] = [];
    const conn = open(upstream, changes);
    await eventually(() => expect(conn.snapshot().status).toBe('connected'));
    upstream.onToolsChanged?.([
      ...upstream.tools,
      { name: 'reverse', inputSchema: { type: 'object' } },
    ]);
    expect(conn.snapshot().tools.map((t) => t.name)).toEqual(['echo', 'reverse']);
    expect(changes).toContain('tools:connected');
  });

  it('is disabled after stop and refuses calls', async () => {
    const upstream = new FakeUpstream();
    const conn = open(upstream);
    await eventually(() => expect(conn.snapshot().status).toBe('connected'));
    await conn.stop();
    expect(conn.snapshot().status).toBe('disabled');
    await expect(conn.callTool('echo', {}, { timeoutMs: 500 })).rejects.toBeInstanceOf(
      UpstreamUnavailable,
    );
  });
});
