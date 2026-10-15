import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';

// Only node:crypto; no native packages (plan v1.1).

/**
 * scrypt parameters for dashboard passwords. N=2^15, r=8, p=3 is one of OWASP's equivalent
 * settings (same cost as N=2^17, p=1) but needs about 32 MiB per hash instead of 128 MiB, so a
 * burst of logins can't exhaust the gateway pod's memory limit.
 */
const SCRYPT = { N: 2 ** 15, r: 8, p: 3, keylen: 64, maxmem: 64 * 1024 * 1024 } as const;

function scryptAsync(password: string, salt: Buffer, params: { N: number; r: number; p: number }) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, SCRYPT.keylen, { ...params, maxmem: SCRYPT.maxmem }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/** Stored as scrypt$N$r$p$salt$hash (base64url), so parameters can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT);
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, N, r, p, salt, hash] = stored.split('$');
  if (algorithm !== 'scrypt' || !N || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Unguessable token for cookies and links (256 bits by default). */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Fast one-way hash for high-entropy tokens (sessions, invites). Passwords use scrypt instead. */
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Keyed hash for API keys: a stolen database alone can't be used to verify guesses. */
export const hmacSha256 = (key: string, value: string) =>
  createHmac('sha256', key).update(value).digest('hex');

/** Constant-time comparison of two hex digests. */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Lower-case alphanumeric id, e.g. the 8-character API key prefix. */
export function randomAlphanumeric(length: number): string {
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    const byte = bytes[i]!;
    // Reject the top of the byte range so every character is equally likely.
    if (byte < 252) out += ALPHANUMERIC[byte % 36];
  }
  return out.length === length ? out : randomAlphanumeric(length);
}

export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/** AES-256-GCM with a 32-byte key (base64 in the gateway-crypto Secret). Used for upstream credentials. */
export function encryptSecret(plaintext: string, key: Buffer): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function decryptSecret(sealed: SealedSecret, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv);
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
}
