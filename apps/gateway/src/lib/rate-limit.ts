/**
 * Fixed-window counter per key, in memory. Enough for login throttling on a single gateway
 * replica; per-key limits shared across replicas come with Valkey in Phase 2 (Task 25).
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records one attempt; returns false when the key is over its limit for this window. */
  tryConsume(key: string): boolean {
    const now = this.now();
    const window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      this.prune(now);
      return true;
    }
    window.count += 1;
    return window.count <= this.limit;
  }

  reset(key: string): void {
    this.windows.delete(key);
  }

  /** Seconds until the key's window resets (for Retry-After). */
  retryAfterSeconds(key: string): number {
    const window = this.windows.get(key);
    return window ? Math.max(1, Math.ceil((window.resetAt - this.now()) / 1000)) : 0;
  }

  private prune(now: number) {
    if (this.windows.size < 10_000) return;
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }
}
