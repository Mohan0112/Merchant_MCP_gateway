import { describe, expect, it } from 'vitest';
import { FixedWindowLimiter } from './rate-limit';

describe('FixedWindowLimiter', () => {
  it('allows up to the limit, then blocks until the window resets', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(3, 60_000, () => now);
    expect([1, 2, 3].map(() => limiter.tryConsume('a'))).toEqual([true, true, true]);
    expect(limiter.tryConsume('a')).toBe(false);
    expect(limiter.retryAfterSeconds('a')).toBe(60);
    expect(limiter.tryConsume('b')).toBe(true);
    now = 60_000;
    expect(limiter.tryConsume('a')).toBe(true);
  });

  it('can be reset after a success', () => {
    const limiter = new FixedWindowLimiter(1, 60_000);
    limiter.tryConsume('a');
    limiter.reset('a');
    expect(limiter.tryConsume('a')).toBe(true);
  });
});
