import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult, UpstreamClient, UpstreamTarget, UpstreamTool } from './client';
import { withTimeout } from './errors';

type SdkTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
};

const toUpstreamTool = (tool: SdkTool): UpstreamTool => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
  outputSchema: tool.outputSchema as Record<string, unknown> | undefined,
  annotations: tool.annotations as Record<string, unknown> | undefined,
});

/**
 * Upstream connection through the MCP SDK v2 client (ADR-0003): protocol version auto-negotiated,
 * the upstream's credential in request headers, and tool-list changes delivered by the SDK
 * (a subscription on 2026-07-28 servers, unsolicited notifications on 2025-era ones).
 */
export class SdkUpstreamClient implements UpstreamClient {
  private client: Client | undefined;

  constructor(
    private readonly target: UpstreamTarget,
    private readonly onToolsChanged: (tools: UpstreamTool[]) => void,
  ) {}

  async connect(timeoutMs: number) {
    const client = new Client(
      { name: 'urumi-gateway', version: '0.1.0' },
      {
        versionNegotiation: { mode: 'auto' },
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (!error && tools) this.onToolsChanged((tools as SdkTool[]).map(toUpstreamTool));
            },
          },
        },
      },
    );
    const transport = new StreamableHTTPClientTransport(new URL(this.target.url), {
      requestInit: { headers: this.target.headers },
    });
    try {
      await withTimeout(client.connect(transport), timeoutMs, 'connect');
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
    this.client = client;
    return { era: client.getProtocolEra() as 'modern' | 'legacy' };
  }

  async listTools(timeoutMs: number) {
    const { tools } = await this.connected().listTools(undefined, { timeout: timeoutMs });
    return (tools as SdkTool[]).map(toUpstreamTool);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ) {
    return (await this.connected().callTool(
      { name, arguments: args },
      { timeout: options.timeoutMs, signal: options.signal },
    )) as CallToolResult;
  }

  async close() {
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => {});
  }

  private connected(): Client {
    if (!this.client) throw new Error('not connected');
    return this.client;
  }
}

export const sdkClientFactory = (
  target: UpstreamTarget,
  onToolsChanged: (tools: UpstreamTool[]) => void,
) => new SdkUpstreamClient(target, onToolsChanged);
