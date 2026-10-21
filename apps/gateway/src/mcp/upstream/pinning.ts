import { sha256 } from '../../lib/crypto';
import type { UpstreamTool } from './client';

/**
 * Tool-definition pinning (threat model: a server that changes its tools after it was approved,
 * the "rug pull"). Every definition is hashed; a tool is exposed only while its current
 * definition matches the approved one. The first listing of a newly added server is trusted (the
 * admin just saw those tools in Test connection); after that, a changed definition or a new tool
 * waits for an admin.
 */
export type ToolReview = 'approved' | 'changed' | 'new';

export interface ApprovedTool {
  hash: string;
  definition: UpstreamTool;
}

/** JSON with sorted keys, so the hash doesn't depend on the order an upstream sends fields in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function definitionHash(tool: UpstreamTool): string {
  return sha256(
    canonical({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    }),
  );
}

/** The approved definitions of one server's tools. */
export class ToolPins {
  constructor(
    private readonly approved = new Map<string, ApprovedTool>(),
    /** False until the server's first successful listing has been trusted. */
    private pinned = false,
  ) {}

  get isPinned(): boolean {
    return this.pinned;
  }

  /** Trusts a whole listing (the first one of a server). */
  trustAll(tools: UpstreamTool[]): void {
    for (const tool of tools) this.approve(tool);
    this.pinned = true;
  }

  approve(tool: UpstreamTool): void {
    this.approved.set(tool.name, { hash: definitionHash(tool), definition: tool });
  }

  review(tool: UpstreamTool): ToolReview {
    const approved = this.approved.get(tool.name);
    if (!approved) return 'new';
    return approved.hash === definitionHash(tool) ? 'approved' : 'changed';
  }

  approvedDefinition(name: string): UpstreamTool | undefined {
    return this.approved.get(name)?.definition;
  }

  /** The tools that may be exposed. */
  visible(tools: UpstreamTool[]): UpstreamTool[] {
    return tools.filter((tool) => this.review(tool) === 'approved');
  }
}
