import type { z } from 'zod';

/** MCP tool annotations (hints for clients and models; never security boundaries). */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * One MCP tool. Each tool is its own object, so adding a tool never changes the server code
 * (open/closed). `execute` returns structured output; the kit turns it into an MCP result.
 */
export interface ToolHandler<
  I extends z.ZodObject = z.ZodObject,
  O extends z.ZodObject = z.ZodObject,
> {
  name: string;
  title?: string;
  description: string;
  inputSchema: I;
  outputSchema?: O;
  annotations?: ToolAnnotations;
  execute(input: z.infer<I>): Promise<z.infer<O>>;
}

/** Identity helper that keeps the input/output types of a tool definition. */
export function defineTool<I extends z.ZodObject, O extends z.ZodObject>(
  tool: ToolHandler<I, O>,
): ToolHandler<I, O> {
  return tool;
}

/**
 * An expected failure whose message is safe to show to the caller (and the model), for example
 * "Order 999 not found". Anything else thrown by a tool is logged and reported generically.
 */
export class ToolError extends Error {
  override name = 'ToolError';
}
