import { describe, expect, it } from 'vitest';
import { ApprovalTokens } from './approvals';

const action = { callId: 'c1', name: 'woo__update_order_status', arguments: { id: 7 }, note: '' };

describe('ApprovalTokens', () => {
  it('redeems a token once, only for the user it was issued to', () => {
    const tokens = new ApprovalTokens('pepper-for-tests');
    const token = tokens.issue('user-1', action);
    expect(tokens.redeem(token, 'user-2')).toBeNull();
    expect(tokens.redeem(token, 'user-1')).toEqual(action);
    expect(tokens.redeem(token, 'user-1')).toBeNull();
  });

  it('rejects tokens that were changed, signed with another key, or expired', () => {
    const clock = { now: new Date('2026-10-22T10:00:00Z') };
    const tokens = new ApprovalTokens('pepper-for-tests', () => clock.now);
    const token = tokens.issue('user-1', action);
    const [payload, signature] = token.split('.');
    const changed = Buffer.from(
      Buffer.from(payload!, 'base64url').toString().replace('"id":7', '"id":8'),
    ).toString('base64url');
    expect(tokens.redeem(`${changed}.${signature}`, 'user-1')).toBeNull();
    expect(new ApprovalTokens('another-pepper').redeem(token, 'user-1')).toBeNull();
    expect(tokens.redeem('not-a-token', 'user-1')).toBeNull();

    clock.now = new Date('2026-10-22T10:11:00Z');
    expect(tokens.redeem(token, 'user-1')).toBeNull();
  });
});
