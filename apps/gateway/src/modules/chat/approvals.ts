import { digestsEqual, hmacSha256, randomToken } from '../../lib/crypto';

const TTL_MS = 10 * 60 * 1000;

/** A tool call the assistant proposed and the user has to approve before it runs. */
export interface PendingAction {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  /** What the assistant said alongside the call. */
  note: string;
}

interface Claims extends PendingAction {
  userId: string;
  expiresAt: number;
  nonce: string;
}

/**
 * Approvals without server-side conversation state: the proposed call is signed (HMAC with a key
 * derived from the server's pepper) and handed to the browser, which sends it back when the user
 * clicks Approve. The signature stops the browser from changing the tool or its arguments, the
 * user binding stops anyone else from using it, and the nonce makes it single-use.
 *
 * Any gateway replica can verify a token. The used-nonce list is per replica, so with several
 * replicas a token could in theory be replayed once per replica within its ten minutes; the call
 * still runs with the user's own permissions and is audited each time.
 */
export class ApprovalTokens {
  private readonly used = new Map<string, number>();
  private readonly key: string;

  constructor(
    pepper: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.key = hmacSha256(pepper, 'chat-approval-key-v1');
  }

  issue(userId: string, action: PendingAction): string {
    const claims: Claims = {
      ...action,
      userId,
      expiresAt: this.now().getTime() + TTL_MS,
      nonce: randomToken(12),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${payload}.${hmacSha256(this.key, payload)}`;
  }

  /** The approved action, or null if the token is forged, someone else's, expired or used. */
  redeem(token: string, userId: string): PendingAction | null {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) return null;
    if (!digestsEqual(hmacSha256(this.key, payload), signature)) return null;
    let claims: Claims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
    } catch {
      return null;
    }
    const now = this.now().getTime();
    this.prune(now);
    if (claims.userId !== userId || claims.expiresAt <= now || this.used.has(claims.nonce)) {
      return null;
    }
    this.used.set(claims.nonce, claims.expiresAt);
    return {
      callId: claims.callId,
      name: claims.name,
      arguments: claims.arguments,
      note: claims.note,
    };
  }

  private prune(now: number): void {
    for (const [nonce, expiresAt] of this.used) if (expiresAt <= now) this.used.delete(nonce);
  }
}
