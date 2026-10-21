import { ChatRequestSchema, type ChatEvent } from '@ahjin/contracts';
import type { FastifyInstance } from 'fastify';
import type { GatewayContext } from '../../context';
import { parse } from '../../lib/http';
import { requireUser } from '../auth/principal';
import type { AssistantSettingsStore } from '../settings/assistant';
import { runAgent } from './agent';
import type { ApprovalTokens, PendingAction } from './approvals';
import { BLOCKED_REPLY, screenMessages } from './guardrails';
import type { LlmProvider } from './llm';
import type { ChatTokenStore } from './tokens';

export interface ChatDeps {
  ctx: GatewayContext;
  chatTokens: ChatTokenStore;
  approvals: ApprovalTokens;
  assistant: AssistantSettingsStore;
  /** null when no LLM key is configured; the chat then explains that instead of failing. */
  provider: LlmProvider | null;
  /** Loopback URL of this gateway's /mcp endpoint. */
  mcpUrl: () => string;
}

/**
 * POST /api/chat streams one chat turn as server-sent events. The chat module calls tools through
 * the gateway's own /mcp endpoint with a short-lived token for the signed-in user, so its calls are
 * authorised, routed and audited exactly like an external MCP client's (channel chat_agent).
 */
export function registerChatRoutes(app: FastifyInstance, deps: ChatDeps) {
  app.post('/api/chat', async (request, reply) => {
    const principal = requireUser(request);
    const { messages, approval } = parse(ChatRequestSchema, request.body);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Request-Id': request.id,
    });
    const emit = (event: ChatEvent) =>
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const end = (event?: ChatEvent) => {
      if (event) emit(event);
      emit({ type: 'done', iterations: 0, toolCalls: 0, provider: null });
      res.end();
    };

    if (!deps.provider) {
      return end({
        type: 'error',
        code: 'not_configured',
        message:
          'No LLM provider is configured. An admin needs to add GROQ_API_KEY or GEMINI_API_KEY.',
      });
    }

    // Jailbreak phrasing never reaches the model; it's refused here, deterministically.
    const screen = screenMessages(messages);
    if (!screen.ok) {
      deps.ctx.logger.warn(
        { userId: principal.userId, rule: screen.rule },
        'chat message refused by guardrail',
      );
      emit({
        type: 'guardrail',
        code: 'refused',
        message: 'This message looks like an attempt to override the assistant’s rules.',
      });
      return end({ type: 'message', text: BLOCKED_REPLY });
    }

    let approved: PendingAction | undefined;
    if (approval) {
      approved = deps.approvals.redeem(approval, principal.userId) ?? undefined;
      if (!approved) {
        return end({
          type: 'error',
          code: 'approval_invalid',
          message: 'That approval has expired or was already used. Ask again to get a new one.',
        });
      }
    }

    // Stop the model and tool calls if the user closes the page. This listens on the response:
    // the request's own 'close' event fires as soon as its body has been read, not on disconnect.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    const token = deps.chatTokens.issue(principal.userId, principal.sessionId);
    try {
      await runAgent({
        provider: deps.provider,
        mcpUrl: deps.mcpUrl(),
        token,
        user: { id: principal.userId, name: principal.name, role: principal.role },
        businessContext: (await deps.assistant.get()).context,
        messages,
        approved,
        approvals: deps.approvals,
        now: deps.ctx.now(),
        emit,
        signal: abort.signal,
      });
    } catch (error) {
      if (!abort.signal.aborted) {
        const status = (error as { status?: number }).status;
        deps.ctx.logger.warn({ err: error }, 'chat turn failed');
        emit({
          type: 'error',
          code: status === 429 ? 'llm_rate_limited' : 'chat_failed',
          message:
            status === 429
              ? 'The language model is rate-limited right now; try again in a minute.'
              : 'The chat failed; try again.',
        });
        emit({ type: 'done', iterations: 0, toolCalls: 0, provider: null });
      }
    } finally {
      deps.chatTokens.revoke(token);
      res.end();
    }
  });
}
