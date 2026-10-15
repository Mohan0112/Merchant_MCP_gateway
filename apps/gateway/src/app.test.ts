import { createLogger } from '@urumi/logger';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { buildApp } from './app';
import { badRequest, fromZodError } from './lib/errors';

const logger = createLogger('test', {
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

function app(dbUp = true) {
  const instance = buildApp({
    logger,
    checkDatabase: async () => {
      if (!dbUp) throw new Error('connection refused');
    },
    version: { name: 'gateway', version: '9.9.9', commit: 'abc123' },
  });
  instance.get('/api/boom', async () => {
    throw new Error('secret internal detail');
  });
  instance.post('/api/form', async (request) => {
    const parsed = z.object({ email: z.email() }).safeParse(request.body);
    if (!parsed.success) throw fromZodError(parsed.error);
    throw badRequest('never reached');
  });
  return instance;
}

describe('gateway app', () => {
  it('serves build info at /api/version', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/version' });
    expect(res.json()).toEqual({ name: 'gateway', version: '9.9.9', commit: 'abc123' });
  });

  it('is ready when the database answers and not ready when it does not', async () => {
    expect((await app(true).inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    const down = await app(false).inject({ method: 'GET', url: '/readyz' });
    expect(down.statusCode).toBe(503);
    expect((await app(false).inject({ method: 'GET', url: '/livez' })).statusCode).toBe(200);
  });

  it('answers unknown routes with problem+json and a request id', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 404, code: 'not_found', instance: '/api/nope' });
    expect(res.json().requestId).toBe(res.headers['x-request-id']);
  });

  it('hides internal error details', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret internal detail');
  });

  it('reports field-level validation errors', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/api/form',
      payload: { email: 'nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors).toEqual([{ field: 'email', message: expect.any(String) }]);
  });

  it('reuses a well-formed incoming X-Request-Id and ignores a malformed one', async () => {
    const reused = await app().inject({
      method: 'GET',
      url: '/livez',
      headers: { 'x-request-id': 'req-12345678' },
    });
    expect(reused.headers['x-request-id']).toBe('req-12345678');
    const replaced = await app().inject({
      method: 'GET',
      url: '/livez',
      headers: { 'x-request-id': 'bad id!' },
    });
    expect(replaced.headers['x-request-id']).not.toBe('bad id!');
  });
});
