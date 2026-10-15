import { describe, expect, it } from 'vitest';
import { apiKeyPrefix, SlugSchema } from './index';

// Built at runtime so no literal key exists in the repo for gitleaks to flag.
const sampleKey = (prefix: string, secret: string) => ['umcp', prefix, secret].join('_');

describe('SlugSchema', () => {
  it.each(['woo', 'fx', 'github', 'store-acme', 'a1'])('accepts %s', (slug) => {
    expect(SlugSchema.safeParse(slug).success).toBe(true);
  });

  it.each(['Woo', 'w', '1woo', 'has_underscore', 'a__b', 'x'.repeat(21), ''])(
    'rejects %s',
    (slug) => {
      expect(SlugSchema.safeParse(slug).success).toBe(false);
    },
  );
});

describe('apiKeyPrefix', () => {
  it('extracts the lookup prefix from a well-formed key', () => {
    expect(apiKeyPrefix(sampleKey('ab12cd34', 'A'.repeat(42) + '_'))).toBe('ab12cd34');
  });

  it('rejects malformed keys', () => {
    expect(apiKeyPrefix(sampleKey('AB12CD34', 'A'.repeat(43)))).toBeNull();
    expect(apiKeyPrefix(sampleKey('ab12cd34', 'A'.repeat(42)))).toBeNull();
    expect(apiKeyPrefix('Bearer something')).toBeNull();
  });
});
