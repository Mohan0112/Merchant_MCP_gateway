export interface ClientSnippet {
  id: string;
  client: string;
  where: string;
  language: 'shell' | 'json' | 'text';
  code: string;
}

/**
 * How to add the gateway to common MCP clients. Each needs only the gateway URL and the user's own
 * key; no upstream server is configured in the client.
 */
export function clientSnippets(gatewayUrl: string, key: string): ClientSnippet[] {
  const header = `Bearer ${key}`;
  return [
    {
      id: 'claude-code',
      client: 'Claude Code',
      where: 'Run in a terminal',
      language: 'shell',
      code: `claude mcp add --transport http ahjin ${gatewayUrl} --header "Authorization: ${header}"`,
    },
    {
      id: 'cursor',
      client: 'Cursor',
      where: '~/.cursor/mcp.json',
      language: 'json',
      code: JSON.stringify(
        { mcpServers: { ahjin: { url: gatewayUrl, headers: { Authorization: header } } } },
        null,
        2,
      ),
    },
    {
      id: 'vscode',
      client: 'VS Code',
      where: '.vscode/mcp.json',
      language: 'json',
      code: JSON.stringify(
        {
          servers: { ahjin: { type: 'http', url: gatewayUrl, headers: { Authorization: header } } },
        },
        null,
        2,
      ),
    },
    {
      id: 'inspector',
      client: 'MCP Inspector',
      where: 'npx @modelcontextprotocol/inspector',
      language: 'text',
      code: `Transport: Streamable HTTP\nURL: ${gatewayUrl}\nHeader: Authorization = ${header}`,
    },
  ];
}
