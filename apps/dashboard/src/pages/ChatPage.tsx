import type { ChatEvent, ChatMessage } from '@ahjin/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ErrorNote, PageHeader, Spinner } from '../components/ui';
import { ApiError } from '../lib/api';
import { duration } from '../lib/format';
import { SseParser } from '../lib/sse';

interface ToolCall {
  callId: string;
  name: string;
  server: string;
  arguments: unknown;
  status: 'running' | 'ok' | 'failed';
  durationMs?: number;
  preview?: string;
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  tools: ToolCall[];
  error?: string;
  pending?: boolean;
  meta?: string;
}

const SUGGESTIONS = [
  'What orders came in today?',
  'Create a product named "Ahjin Laptop Sleeve 14" with a price of 1499.',
  "What is today's order total in US dollars?",
  'Which gaming laptops are in stock, and at what price?',
];

/** Sends one chat turn and applies each server-sent event as it arrives. */
async function streamTurn(
  messages: ChatMessage[],
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!res.ok || !res.body) {
    const problem = (await res.json().catch(() => ({}))) as { detail?: string; code?: string };
    throw new ApiError(
      res.status,
      problem.code ?? 'error',
      problem.detail ?? `Chat failed (HTTP ${res.status}).`,
    );
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const parser = new SseParser();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const event of parser.push(value)) onEvent(event);
  }
}

function ToolCallView({ call }: { call: ToolCall }) {
  return (
    <details className="tool-call">
      <summary>
        {call.status === 'running' ? (
          <Spinner />
        ) : (
          <span>{call.status === 'ok' ? '✅' : '⚠️'}</span>
        )}
        <code style={{ fontWeight: 600 }}>{call.name}</code>
        <span className="muted">
          {call.status === 'running'
            ? 'running…'
            : `${call.status === 'ok' ? 'done' : 'failed'} in ${duration(call.durationMs)}`}
        </span>
      </summary>
      <div className="detail">
        <div className="muted">Arguments</div>
        <pre className="mono">{JSON.stringify(call.arguments, null, 2)}</pre>
        {call.preview ? (
          <>
            <div className="muted" style={{ marginTop: 6 }}>
              Result (first 400 characters)
            </div>
            <pre className="mono">{call.preview}</pre>
          </>
        ) : null}
      </div>
    </details>
  );
}

export function ChatPage() {
  const client = useQueryClient();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState<unknown>(null);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const busy = turns.some((t) => t.pending);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);
  useEffect(() => () => abort.current?.abort(), []);

  const updateLast = (change: (turn: Turn) => Turn) =>
    setTurns((current) => [...current.slice(0, -1), change(current.at(-1)!)]);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    setError(null);
    setInput('');
    // The history the model sees: earlier questions and answers, without tool details or errors.
    const history: ChatMessage[] = [
      ...turns
        .filter((t) => t.content && !t.error)
        .map((t): ChatMessage => ({ role: t.role, content: t.content })),
      { role: 'user' as const, content: question },
    ].slice(-20);
    setTurns((current) => [
      ...current,
      { role: 'user', content: question, tools: [] },
      { role: 'assistant', content: '', tools: [], pending: true },
    ]);
    const controller = new AbortController();
    abort.current = controller;
    try {
      await streamTurn(history, controller.signal, (event) => {
        switch (event.type) {
          case 'tool.started':
            updateLast((turn) => ({
              ...turn,
              tools: [
                ...turn.tools,
                {
                  callId: event.callId,
                  name: event.name,
                  server: event.server,
                  arguments: event.arguments,
                  status: 'running',
                },
              ],
            }));
            break;
          case 'tool.completed':
            updateLast((turn) => ({
              ...turn,
              tools: turn.tools.map((call) =>
                call.callId === event.callId
                  ? {
                      ...call,
                      status: event.ok ? 'ok' : 'failed',
                      durationMs: event.durationMs,
                      preview: event.preview,
                    }
                  : call,
              ),
            }));
            break;
          case 'message':
            updateLast((turn) => ({ ...turn, content: event.text }));
            break;
          case 'error':
            updateLast((turn) => ({ ...turn, error: event.message }));
            break;
          case 'done':
            updateLast((turn) => ({
              ...turn,
              pending: false,
              meta: event.provider
                ? `${event.provider} · ${event.toolCalls} tool call${event.toolCalls === 1 ? '' : 's'}`
                : undefined,
            }));
            break;
        }
      });
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught);
      else updateLast((turn) => ({ ...turn, error: 'Stopped.' }));
    } finally {
      updateLast((turn) => ({ ...turn, pending: false }));
      abort.current = null;
      // Tool calls may have changed data shown elsewhere (new products, the audit log).
      void client.invalidateQueries({ queryKey: ['audit'] });
    }
  };

  return (
    <>
      <PageHeader
        title="Chat"
        description="Ask about your store. The assistant calls tools through the gateway as you, so every call is in the audit log under your name."
        actions={
          turns.length ? (
            <button className="btn" disabled={busy} onClick={() => setTurns([])}>
              New chat
            </button>
          ) : null
        }
      />
      <div className="card chat">
        <div className="chat-log">
          {turns.length === 0 ? (
            <div className="empty stack" style={{ alignItems: 'center' }}>
              <div>Try one of these:</div>
              <div className="suggestions" style={{ justifyContent: 'center' }}>
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="suggestion" onClick={() => void send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {turns.map((turn, index) =>
            turn.role === 'user' ? (
              <div key={index} className="msg user">
                {turn.content}
              </div>
            ) : (
              <div key={index} className="msg assistant">
                {turn.tools.map((call) => (
                  <ToolCallView key={call.callId} call={call} />
                ))}
                {turn.content || turn.error || turn.pending ? (
                  <div className="bubble">
                    {turn.content ? (
                      <Markdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          a: ({ node: _node, ...props }) => (
                            <a {...props} target="_blank" rel="noreferrer" />
                          ),
                        }}
                      >
                        {turn.content}
                      </Markdown>
                    ) : null}
                    {turn.error ? (
                      <div className="alert" style={{ marginTop: turn.content ? 8 : 0 }}>
                        {turn.error}
                      </div>
                    ) : null}
                    {turn.pending && !turn.content ? (
                      <div className="row muted">
                        <Spinner /> {turn.tools.length ? 'Working with the tools…' : 'Thinking…'}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {turn.meta ? (
                  <div className="muted small" style={{ marginTop: 4 }}>
                    {turn.meta}
                  </div>
                ) : null}
              </div>
            ),
          )}
          <div ref={bottom} />
        </div>
        <ErrorNote error={error} />
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send(input);
          }}
        >
          <textarea
            rows={1}
            value={input}
            placeholder="Ask about products and orders, or ask for a change…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send(input);
              }
            }}
          />
          {busy ? (
            <button type="button" className="btn" onClick={() => abort.current?.abort()}>
              Stop
            </button>
          ) : (
            <button className="btn primary" disabled={!input.trim()}>
              Send
            </button>
          )}
        </form>
      </div>
    </>
  );
}
