import { describe, expect, it } from 'vitest';
import { duration, timeAgo, toolOnly } from './format';
import { clientSnippets } from './snippets';
import { SseParser } from './sse';

describe('SseParser', () => {
  it('returns complete events and keeps a partial one for the next chunk', () => {
    const parser = new SseParser();
    const first = parser.push('event: message\ndata: {"type":"message","text":"Hel');
    expect(first).toEqual([]);
    const second = parser.push(
      'lo"}\n\nevent: done\ndata: {"type":"done","iterations":1,"toolCalls":0,"provider":"groq"}\n\n',
    );
    expect(second).toEqual([
      { type: 'message', text: 'Hello' },
      { type: 'done', iterations: 1, toolCalls: 0, provider: 'groq' },
    ]);
  });

  it('accepts CRLF line endings and skips malformed events', () => {
    const parser = new SseParser();
    expect(
      parser.push('data: not json\r\n\r\ndata: {"type":"message","text":"ok"}\r\n\r\n'),
    ).toEqual([{ type: 'message', text: 'ok' }]);
  });
});

describe('format', () => {
  it('formats durations and relative times', () => {
    expect(duration(850)).toBe('850 ms');
    expect(duration(1530)).toBe('1.53 s');
    expect(duration(null)).toBe('—');
    expect(timeAgo(null)).toBe('never');
    expect(timeAgo(new Date(Date.now() - 10_000).toISOString())).toBe('just now');
  });

  it('strips the server prefix of a tool name', () => {
    expect(toolOnly('woo__list_orders')).toBe('list_orders');
    expect(toolOnly('plain')).toBe('plain');
  });
});

describe('client snippets', () => {
  it('needs only the gateway URL and the key', () => {
    const snippets = clientSnippets('https://app.example.com/mcp', 'amcp_abc');
    const claude = snippets.find((s) => s.id === 'claude-code')!;
    expect(claude.code).toBe(
      'claude mcp add --transport http ahjin https://app.example.com/mcp --header "Authorization: Bearer amcp_abc"',
    );
    const cursor = JSON.parse(snippets.find((s) => s.id === 'cursor')!.code);
    expect(cursor.mcpServers.ahjin).toEqual({
      url: 'https://app.example.com/mcp',
      headers: { Authorization: 'Bearer amcp_abc' },
    });
  });
});
