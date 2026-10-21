import type { ChatEvent, ChatMessage, Role } from '@ahjin/contracts';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { slugOf } from '../../mcp/naming';
import type { ApprovalTokens, PendingAction } from './approvals';
import { claimsStoreData, needsApproval, redactSecrets } from './guardrails';
import type { LlmMessage, LlmProvider, LlmTool, LlmToolCall } from './llm';
import { summarizeServers, systemPrompt, VERIFY_WITH_TOOLS } from './prompt';

export interface AgentOptions {
  provider: LlmProvider;
  /** The gateway's own MCP endpoint; the agent is just another MCP client (ADR-005). */
  mcpUrl: string;
  /** Chat token that makes the gateway treat these calls as the signed-in user. */
  token: string;
  user: { id: string; name: string; role: Role };
  /** What the assistant knows about the business (Settings → Assistant). */
  businessContext: string;
  messages: ChatMessage[];
  /** A change the user just approved: it runs first, then the conversation continues. */
  approved?: PendingAction;
  approvals: ApprovalTokens;
  now: Date;
  emit: (event: ChatEvent) => void;
  signal?: AbortSignal;
  maxIterations?: number;
  budgetMs?: number;
}

const MAX_RESULT_CHARS = 16_000;

interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

const textOf = (result: { content?: unknown; structuredContent?: unknown }) => {
  const text = ((result.content ?? []) as Array<{ text?: string }>)
    .map((c) => c.text ?? '')
    .join('\n');
  return (text || JSON.stringify(result.structuredContent ?? {})).slice(0, MAX_RESULT_CHARS);
};

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || '{}') as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    // Malformed arguments from the model: send an empty object and let validation explain.
    return {};
  }
}

/**
 * The chat tool loop: list the user's tools through the gateway, let the model pick tool calls,
 * run them through the gateway (so permissions and audit apply), feed results back, repeat until
 * the model answers or the iteration/time budget runs out. Around the model:
 * - calls that may change data pause for the user's approval (needsApproval);
 * - an answer stating store data without a single tool call is sent back once to be verified;
 * - secrets and internal addresses are removed from everything the model or the browser sees.
 */
export async function runAgent(options: AgentOptions): Promise<void> {
  const run = new AgentRun(options);
  try {
    await run.execute();
  } finally {
    await run.close();
  }
}

class AgentRun {
  private readonly client = new Client(
    { name: 'ahjin-chat', version: '0.1.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  private readonly history: LlmMessage[] = [];
  private readonly tools = new Map<string, ListedTool>();
  private readonly maxIterations: number;
  private readonly deadline: number;
  private toolCalls = 0;
  private provider: string | null = null;
  private verified = false;

  constructor(private readonly options: AgentOptions) {
    this.maxIterations = options.maxIterations ?? 8;
    this.deadline = Date.now() + (options.budgetMs ?? 120_000);
  }

  async execute(): Promise<void> {
    const llmTools = await this.connect();
    this.history.push(
      {
        role: 'system',
        content: systemPrompt({
          now: this.options.now,
          user: this.options.user,
          businessContext: this.options.businessContext,
          servers: summarizeServers([...this.tools.values()]),
        }),
      },
      ...this.options.messages.map((m) => ({ role: m.role, content: m.content }) as LlmMessage),
    );
    if (this.options.approved) await this.runApproved(this.options.approved);

    for (let iteration = 1; iteration <= this.maxIterations; iteration++) {
      if (Date.now() > this.deadline) {
        this.fail('budget_exceeded', 'The answer took too long; try a narrower question.');
        return this.done(iteration - 1);
      }
      const turn = (await this.options.provider.complete(
        this.history,
        llmTools,
        this.options.signal,
      )) as Awaited<ReturnType<LlmProvider['complete']>> & { provider?: string };
      this.provider = turn.provider ?? this.options.provider.name;

      if (turn.toolCalls.length === 0) {
        if (!this.verified && this.toolCalls === 0 && claimsStoreData(turn.content)) {
          // Numbers without a single tool call are how invented answers look; ask once to verify.
          this.verified = true;
          this.history.push(
            { role: 'assistant', content: turn.content },
            { role: 'user', content: VERIFY_WITH_TOOLS },
          );
          continue;
        }
        this.answer(turn.content || '(no answer)');
        return this.done(iteration);
      }

      const gated = turn.toolCalls.find((call) =>
        needsApproval(this.tools.get(call.name)?.annotations),
      );
      if (gated) {
        this.askApproval(gated, turn.content);
        return this.done(iteration);
      }

      this.history.push(this.assistantCalling(turn.toolCalls, turn.content));
      // Independent tool calls of one turn run in parallel.
      const results = await Promise.all(turn.toolCalls.map((call) => this.callTool(call)));
      for (const result of results) this.history.push(result);
    }

    this.fail('iteration_limit', 'Stopped after too many tool rounds; try a narrower question.');
    this.done(this.maxIterations);
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => {});
  }

  private async connect(): Promise<LlmTool[]> {
    await this.client.connect(
      new StreamableHTTPClientTransport(new URL(this.options.mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${this.options.token}` } },
      }),
    );
    const { tools } = await this.client.listTools();
    for (const tool of tools) this.tools.set(tool.name, tool as ListedTool);
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.name,
      parameters: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
    }));
  }

  /** The approved call runs as if the model had just made it, so the model then reports the result. */
  private async runApproved(action: PendingAction): Promise<void> {
    const call: LlmToolCall = {
      id: action.callId,
      name: action.name,
      arguments: JSON.stringify(action.arguments),
    };
    this.history.push(this.assistantCalling([call], action.note));
    this.history.push(await this.callTool(call));
  }

  private assistantCalling(calls: LlmToolCall[], content: string): LlmMessage {
    return {
      role: 'assistant',
      content: content || null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }

  private askApproval(call: LlmToolCall, note: string): void {
    const action: PendingAction = {
      callId: call.id,
      name: call.name,
      arguments: parseArguments(call.arguments),
      note: redactSecrets(note).text,
    };
    this.options.emit({
      type: 'confirmation.required',
      callId: call.id,
      name: call.name,
      server: slugOf(call.name) ?? '',
      arguments: action.arguments,
      note: action.note,
      approval: this.options.approvals.issue(this.options.user.id, action),
    });
  }

  private async callTool(call: LlmToolCall): Promise<LlmMessage> {
    const args = parseArguments(call.arguments);
    this.options.emit({
      type: 'tool.started',
      callId: call.id,
      name: call.name,
      server: slugOf(call.name) ?? '',
      arguments: args,
    });
    const started = Date.now();
    this.toolCalls += 1;
    let ok = false;
    let text: string;
    try {
      const result = await this.client.callTool(
        { name: call.name, arguments: args },
        { timeout: 60_000 },
      );
      ok = !result.isError;
      text = textOf(result as never);
    } catch (error) {
      text = (error as Error).message;
    }
    const clean = redactSecrets(text).text;
    this.options.emit({
      type: 'tool.completed',
      callId: call.id,
      name: call.name,
      ok,
      durationMs: Date.now() - started,
      preview: clean.slice(0, 400),
    });
    return { role: 'tool', tool_call_id: call.id, content: ok ? clean : `ERROR: ${clean}` };
  }

  private answer(text: string): void {
    const { text: clean, redacted } = redactSecrets(text);
    if (redacted) {
      this.options.emit({
        type: 'guardrail',
        code: 'redacted',
        message: `Removed ${redacted} secret${redacted === 1 ? '' : 's'} or internal address${redacted === 1 ? '' : 'es'} from the answer.`,
      });
    }
    this.options.emit({ type: 'message', text: clean });
  }

  private fail(code: string, message: string): void {
    this.options.emit({ type: 'error', code, message });
  }

  private done(iterations: number): void {
    this.options.emit({
      type: 'done',
      iterations,
      toolCalls: this.toolCalls,
      provider: this.provider,
    });
  }
}
