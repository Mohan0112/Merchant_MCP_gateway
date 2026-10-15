import OpenAI from 'openai';

export type LlmMessage = OpenAI.Chat.ChatCompletionMessageParam;

export interface LlmTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmTurn {
  content: string;
  toolCalls: LlmToolCall[];
}

/** Any chat model that can call tools. Real providers and test fakes implement the same interface. */
export interface LlmProvider {
  readonly name: string;
  complete(messages: LlmMessage[], tools: LlmTool[], signal?: AbortSignal): Promise<LlmTurn>;
}

/** Strips JSON-Schema keywords some providers reject; MCP tool schemas otherwise pass through. */
function toParameters(schema: Record<string, unknown>): Record<string, unknown> {
  const parameters = { ...schema };
  delete parameters.$schema;
  return parameters;
}

/** Groq, Gemini (OpenAI-compatible endpoint), Ollama or OpenAI: one adapter, chosen by base URL. */
export class OpenAiCompatibleProvider implements LlmProvider {
  private readonly client: OpenAI;

  constructor(
    readonly name: string,
    private readonly model: string,
    options: { baseURL: string; apiKey: string },
  ) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: 60_000,
      maxRetries: 2,
    });
  }

  async complete(messages: LlmMessage[], tools: LlmTool[], signal?: AbortSignal): Promise<LlmTurn> {
    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages,
        ...(tools.length
          ? {
              tools: tools.map((tool) => ({
                type: 'function' as const,
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: toParameters(tool.parameters),
                },
              })),
              tool_choice: 'auto' as const,
            }
          : {}),
      },
      { signal },
    );
    const message = response.choices[0]?.message;
    return {
      content: message?.content ?? '',
      toolCalls: (message?.tool_calls ?? [])
        .filter((call) => call.type === 'function')
        .map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments || '{}',
        })),
    };
  }
}

/** Tries providers in order: the free tier of one being rate-limited or down doesn't stop the chat. */
export class FallbackProvider implements LlmProvider {
  constructor(private readonly providers: LlmProvider[]) {}

  get name() {
    return this.providers.map((p) => p.name).join(' → ');
  }

  async complete(
    messages: LlmMessage[],
    tools: LlmTool[],
    signal?: AbortSignal,
  ): Promise<LlmTurn & { provider?: string }> {
    let lastError: unknown;
    for (const provider of this.providers) {
      try {
        return { ...(await provider.complete(messages, tools, signal)), provider: provider.name };
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new Error('no LLM provider configured');
  }
}

/** Plays back fixed turns. Lets tests drive the real tool loop without calling a model. */
export class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly seen: LlmMessage[][] = [];

  constructor(private readonly turns: LlmTurn[]) {}

  async complete(messages: LlmMessage[]): Promise<LlmTurn> {
    this.seen.push(messages);
    return this.turns.shift() ?? { content: 'Done.', toolCalls: [] };
  }
}
