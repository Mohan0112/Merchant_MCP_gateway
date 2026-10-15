import { EventEmitter } from 'node:events';
import type { UpstreamConnection } from './upstream/connection';
import type { UpstreamManager } from './upstream/manager';
import { exposedName } from './naming';

/** A tool as the gateway exposes it to MCP clients. */
export interface ExposedToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface CatalogTool {
  definition: ExposedToolDefinition;
  serverId: string;
  slug: string;
  displayName: string;
  originalName: string;
  timeoutMs: number;
  connection: UpstreamConnection;
}

/** Upstream descriptions are untrusted text; cap them so one server can't flood the model's context. */
const MAX_DESCRIPTION = 2000;

/**
 * The aggregated tool list (ADR-004): an immutable snapshot of every enabled and connected
 * server's tools, rebuilt when the manager reports a change. tools/list reads the snapshot and
 * never waits on an upstream. Emits `changed` only when the exposed tools really changed.
 */
export class ToolCatalog extends EventEmitter {
  private tools = new Map<string, CatalogTool>();
  private fingerprint = '';

  constructor(private readonly manager: UpstreamManager) {
    super();
    manager.on('catalog.changed', () => this.rebuild());
    this.rebuild();
  }

  rebuild(): void {
    const next = new Map<string, CatalogTool>();
    for (const upstream of this.manager.connected()) {
      for (const tool of upstream.tools) {
        const name = exposedName(upstream.slug, tool.name);
        const description = `[${upstream.displayName}] ${tool.description ?? ''}`
          .trim()
          .slice(0, MAX_DESCRIPTION);
        const title = `${upstream.displayName}: ${tool.title ?? tool.name}`;
        next.set(name, {
          definition: {
            name,
            title,
            description,
            inputSchema: tool.inputSchema,
            ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
            ...(tool.annotations ? { annotations: { ...tool.annotations, title } } : {}),
          },
          serverId: upstream.serverId,
          slug: upstream.slug,
          displayName: upstream.displayName,
          originalName: tool.name,
          timeoutMs: upstream.timeoutMs,
          connection: upstream.connection,
        });
      }
    }
    this.tools = next;
    const fingerprint = JSON.stringify([...next.values()].map((t) => t.definition));
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.emit('changed');
    }
  }

  /** Tools visible to a caller. Phase 2 (Task 23) filters by per-role and per-user policies here. */
  list(): ExposedToolDefinition[] {
    return [...this.tools.values()]
      .map((t) => t.definition)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  resolve(name: string): CatalogTool | undefined {
    return this.tools.get(name);
  }

  size(): number {
    return this.tools.size;
  }
}
