import { describe, expect, it } from 'vitest';
import { classifyError, UpstreamTimeout } from './errors';

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

describe('classifyError', () => {
  it('finds a network error under the SDK wrappers', () => {
    const wrapped = Object.assign(new Error('Version negotiation probe failed: fetch failed'), {
      code: 'ERA_NEGOTIATION_FAILED',
      cause: Object.assign(new TypeError('fetch failed'), {
        cause: withCode('connect ECONNREFUSED', 'ECONNREFUSED'),
      }),
    });
    expect(classifyError(wrapped)).toEqual({
      reason: 'CONNECTION_REFUSED',
      message: 'connection refused',
    });
    expect(classifyError(withCode('getaddrinfo ENOTFOUND woo-mcp', 'ENOTFOUND')).reason).toBe(
      'DNS',
    );
  });

  it('reports rejected credentials and other HTTP errors', () => {
    expect(classifyError(Object.assign(new Error('x'), { status: 401 })).reason).toBe('AUTH');
    expect(classifyError(Object.assign(new Error('x'), { cause: { status: 403 } })).reason).toBe(
      'AUTH',
    );
    expect(classifyError(Object.assign(new Error('x'), { status: 502 }))).toEqual({
      reason: 'HTTP_ERROR',
      message: 'upstream answered HTTP 502',
    });
  });

  it('reports timeouts and TLS problems', () => {
    expect(classifyError(new UpstreamTimeout('connect: no response within 5s')).reason).toBe(
      'TIMEOUT',
    );
    expect(classifyError(withCode('Request timed out', 'REQUEST_TIMEOUT')).reason).toBe('TIMEOUT');
    expect(classifyError(withCode('self-signed', 'DEPTH_ZERO_SELF_SIGNED_CERT')).reason).toBe(
      'TLS',
    );
  });

  it('falls back to PROTOCOL with the whole message chain', () => {
    const error = Object.assign(new Error('fetch failed'), { cause: new Error('bad port') });
    expect(classifyError(error)).toEqual({ reason: 'PROTOCOL', message: 'fetch failed: bad port' });
  });
});
