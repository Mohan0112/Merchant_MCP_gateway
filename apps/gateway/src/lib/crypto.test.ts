import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  digestsEqual,
  encryptSecret,
  hashPassword,
  hmacSha256,
  randomAlphanumeric,
  verifyPassword,
} from './crypto';

describe('passwords', () => {
  it('verifies the right password and rejects others', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored).toMatch(/^scrypt\$32768\$8\$3\$/);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('wrong password', stored)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('rejects malformed stored values', async () => {
    expect(await verifyPassword('x', 'bcrypt$whatever')).toBe(false);
  });
});

describe('keyed hashes', () => {
  it('depend on the pepper', () => {
    expect(hmacSha256('pepper-a', 'key')).not.toBe(hmacSha256('pepper-b', 'key'));
    expect(digestsEqual(hmacSha256('p', 'k'), hmacSha256('p', 'k'))).toBe(true);
    expect(digestsEqual(hmacSha256('p', 'k'), hmacSha256('p', 'other'))).toBe(false);
  });
});

describe('random ids', () => {
  it('are lower-case alphanumeric of the requested length', () => {
    for (let i = 0; i < 50; i++) expect(randomAlphanumeric(8)).toMatch(/^[a-z0-9]{8}$/);
  });
});

describe('AES-256-GCM secrets', () => {
  const key = randomBytes(32);

  it('round-trips', () => {
    expect(decryptSecret(encryptSecret('ghp_example', key), key)).toBe('ghp_example');
  });

  it('uses a fresh IV every time', () => {
    expect(encryptSecret('same', key).iv.equals(encryptSecret('same', key).iv)).toBe(false);
  });

  it('detects tampering and wrong keys', () => {
    const sealed = encryptSecret('secret', key);
    sealed.ciphertext[0] = sealed.ciphertext[0]! ^ 0xff;
    expect(() => decryptSecret(sealed, key)).toThrow();
    expect(() => decryptSecret(encryptSecret('secret', key), randomBytes(32))).toThrow();
  });
});
