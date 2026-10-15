import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './index';

function captureLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { logger: createLogger('test', { destination }), lines };
}

describe('createLogger', () => {
  it('redacts secrets at the top level and one level deep', () => {
    const { logger, lines } = captureLogger();
    logger.info({ token: 'top-secret', upstream: { credential: 'abc', name: 'woo' } }, 'hello');

    const entry = JSON.parse(lines[0] ?? '{}');
    expect(entry.token).toBe('[REDACTED]');
    expect(entry.upstream.credential).toBe('[REDACTED]');
    expect(entry.upstream.name).toBe('woo');
    expect(lines.join('')).not.toContain('top-secret');
  });

  it('redacts the Authorization header of logged requests', () => {
    const { logger, lines } = captureLogger();
    logger.info({ req: { headers: { authorization: 'Bearer xyz', host: 'app' } } }, 'request');

    const entry = JSON.parse(lines[0] ?? '{}');
    expect(entry.req.headers.authorization).toBe('[REDACTED]');
    expect(entry.req.headers.host).toBe('app');
  });

  it('tags every line with the service name', () => {
    const { logger, lines } = captureLogger();
    logger.info('ping');
    expect(JSON.parse(lines[0] ?? '{}').service).toBe('test');
  });
});
