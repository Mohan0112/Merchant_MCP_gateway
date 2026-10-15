import { describe, expect, it } from 'vitest';
import { isAuthorized } from './credential';

describe('isAuthorized', () => {
  const bearer = { type: 'bearer' as const, token: 's3cret' };
  const header = { type: 'header' as const, header: 'X-API-Key', value: 'k3y' };

  it('accepts the right bearer token', () => {
    expect(isAuthorized(bearer, { authorization: 'Bearer s3cret' })).toBe(true);
  });

  it('rejects a wrong, missing or malformed bearer token', () => {
    expect(isAuthorized(bearer, { authorization: 'Bearer nope' })).toBe(false);
    expect(isAuthorized(bearer, {})).toBe(false);
    expect(isAuthorized(bearer, { authorization: 's3cret' })).toBe(false);
  });

  it('matches custom headers case-insensitively by name', () => {
    expect(isAuthorized(header, { 'x-api-key': 'k3y' })).toBe(true);
    expect(isAuthorized(header, { 'x-api-key': 'other' })).toBe(false);
    expect(isAuthorized(header, { authorization: 'Bearer k3y' })).toBe(false);
  });
});
