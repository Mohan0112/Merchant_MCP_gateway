import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The static credential the gateway must present. Our MCP servers are only reachable by the
 * gateway (NetworkPolicy); the credential is defence in depth on top of that.
 */
export type StaticCredential =
  { type: 'bearer'; token: string } | { type: 'header'; header: string; value: string };

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Constant-time comparison; hashing first makes both buffers the same length. */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export function isAuthorized(
  credential: StaticCredential,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  if (credential.type === 'bearer') {
    const value = headers.authorization;
    if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
    return safeEqual(value.slice('Bearer '.length), credential.token);
  }
  const value = headers[credential.header.toLowerCase()];
  return typeof value === 'string' && safeEqual(value, credential.value);
}
