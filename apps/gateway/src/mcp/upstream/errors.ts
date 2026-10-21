import type { UnreachableReason } from '@ahjin/contracts';

export interface Failure {
  reason: UnreachableReason;
  message: string;
}

/** Errors that mean "the upstream answered, but said no" rather than "the upstream is unhealthy". */
export function isProtocolLevelError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'ProtocolError';
}

const NETWORK: Record<string, Failure> = {
  ECONNREFUSED: { reason: 'CONNECTION_REFUSED', message: 'connection refused' },
  ENOTFOUND: { reason: 'DNS', message: 'host name not found' },
  EAI_AGAIN: { reason: 'DNS', message: 'DNS lookup failed' },
  ETIMEDOUT: { reason: 'TIMEOUT', message: 'connection timed out' },
  UND_ERR_CONNECT_TIMEOUT: { reason: 'TIMEOUT', message: 'connection timed out' },
  ECONNRESET: { reason: 'PROTOCOL', message: 'connection reset by the upstream' },
  UND_ERR_SOCKET: { reason: 'PROTOCOL', message: 'connection closed by the upstream' },
  EHOSTUNREACH: { reason: 'CONNECTION_REFUSED', message: 'host unreachable' },
  ENETUNREACH: { reason: 'CONNECTION_REFUSED', message: 'network unreachable' },
};

const isTlsCode = (code: string) => code.startsWith('ERR_TLS') || code.includes('CERT');

type ErrorLike = { name?: string; code?: unknown; status?: unknown; message?: string };

/** The error and its causes, outermost first: the SDK wraps network errors (e.g. ERA_NEGOTIATION_FAILED → fetch failed → ECONNREFUSED). */
function causeChain(error: unknown): ErrorLike[] {
  const chain: ErrorLike[] = [];
  let current: unknown = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 6; depth++) {
    chain.push(current as ErrorLike);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * Turns whatever the MCP SDK or the network threw into a reason the dashboard can show and an
 * operator can act on (plan §8.1.6). The most specific cause wins over the wrapper around it.
 */
export function classifyError(error: unknown): Failure {
  const chain = causeChain(error);
  for (const e of chain) {
    if (typeof e.status === 'number') {
      if (e.status === 401 || e.status === 403) {
        return { reason: 'AUTH', message: `upstream rejected the credential (HTTP ${e.status})` };
      }
      return { reason: 'HTTP_ERROR', message: `upstream answered HTTP ${e.status}` };
    }
    if (e.code === 'CLIENT_HTTP_AUTHENTICATION' || e.code === 'CLIENT_HTTP_FORBIDDEN') {
      return { reason: 'AUTH', message: 'upstream rejected the credential' };
    }
    if (e.code === 'REQUEST_TIMEOUT' || e.name === 'TimeoutError' || e.name === 'UpstreamTimeout') {
      return { reason: 'TIMEOUT', message: e.message || 'upstream did not respond in time' };
    }
    if (typeof e.code === 'string' && NETWORK[e.code]) return NETWORK[e.code]!;
    if (typeof e.code === 'string' && isTlsCode(e.code))
      return { reason: 'TLS', message: `TLS error (${e.code})` };
  }
  const message =
    chain
      .map((e) => e.message)
      .filter(Boolean)
      .join(': ') || 'unexpected error';
  return { reason: 'PROTOCOL', message: message.slice(0, 200) };
}

/** Thrown when a deadline passes before an operation finishes. */
export class UpstreamTimeout extends Error {
  override name = 'UpstreamTimeout';
}

/** Resolves or rejects with the operation, or rejects with UpstreamTimeout after `ms`. */
export async function withTimeout<T>(operation: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new UpstreamTimeout(`${what}: no response within ${ms / 1000}s`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
