import { sha256 } from '../lib/crypto';

/**
 * Tool naming (ADR-003): every exposed tool is `<server slug>__<tool name>`. Slugs can't contain
 * "_", so the first "__" always separates them, two servers can never collide, and no server can
 * shadow another's tool. Names are kept within ^[A-Za-z0-9_-]{1,64}$, the strictest rule among
 * common MCP clients and LLM APIs.
 */
export const SEPARATOR = '__';
const MAX_LENGTH = 64;

export function exposedName(slug: string, toolName: string): string {
  const safe = toolName.replace(/[^A-Za-z0-9_-]/g, '_');
  const full = `${slug}${SEPARATOR}${safe}`;
  if (full.length <= MAX_LENGTH) return full;
  // Too long: keep a readable start and add a short hash of the original, stable across restarts.
  const hash = sha256(toolName).slice(0, 8);
  const room = MAX_LENGTH - slug.length - SEPARATOR.length - hash.length - 1;
  return `${slug}${SEPARATOR}${safe.slice(0, room)}_${hash}`;
}

/** The slug part of an exposed name, or null when the name has no valid prefix. */
export function slugOf(name: string): string | null {
  const index = name.indexOf(SEPARATOR);
  return index > 0 ? name.slice(0, index) : null;
}
