/** A tool as an upstream MCP server describes it. */
export interface UpstreamTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** The result of a tools/call, passed through to the caller unchanged. */
export type CallToolResult = {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
};

/**
 * One connection to one upstream MCP server. The MCP SDK implementation is used in production;
 * tests substitute fakes (slow, dead, flaky) behind the same interface.
 */
export interface UpstreamClient {
  connect(timeoutMs: number): Promise<{ era: 'modern' | 'legacy' }>;
  listTools(timeoutMs: number): Promise<UpstreamTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** Where an upstream lives and the headers that carry its credential (built server-side only). */
export interface UpstreamTarget {
  url: string;
  headers: Record<string, string>;
}

export type UpstreamClientFactory = (
  target: UpstreamTarget,
  onToolsChanged: (tools: UpstreamTool[]) => void,
) => UpstreamClient;
