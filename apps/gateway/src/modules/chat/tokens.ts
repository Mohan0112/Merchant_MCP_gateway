import { randomToken, sha256 } from '../../lib/crypto';

const TTL_MS = 5 * 60 * 1000;

export interface ChatTokenClaims {
  userId: string;
  sessionId: string;
  expiresAt: number;
}

/**
 * Short-lived tokens that let the chat module call the gateway's own /mcp endpoint as the signed-in
 * user (ADR-005). They live only in this process's memory, are never shown to anyone, expire after
 * five minutes, and are only honoured while the user's dashboard session is still alive.
 */
export class ChatTokenStore {
  private readonly tokens = new Map<string, ChatTokenClaims>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  issue(userId: string, sessionId: string): string {
    this.prune();
    const token = `uchat_${randomToken(32)}`;
    this.tokens.set(sha256(token), { userId, sessionId, expiresAt: this.now().getTime() + TTL_MS });
    return token;
  }

  verify(token: string): ChatTokenClaims | null {
    const key = sha256(token);
    const claims = this.tokens.get(key);
    if (!claims) return null;
    if (claims.expiresAt <= this.now().getTime()) {
      this.tokens.delete(key);
      return null;
    }
    return claims;
  }

  revoke(token: string): void {
    this.tokens.delete(sha256(token));
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [key, claims] of this.tokens) if (claims.expiresAt <= now) this.tokens.delete(key);
  }
}
