import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isNotFound, KubeClient, KubeError } from './client';

let server: Server;
let base: string;
const seen: Array<{ method: string; url: string; type?: string; auth?: string; body: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({
        method: req.method!,
        url: req.url!,
        type: req.headers['content-type'],
        auth: req.headers.authorization,
        body,
      });
      res.setHeader('content-type', 'application/json');
      if (req.url?.endsWith('/missing')) {
        res.statusCode = 404;
        res.end(
          JSON.stringify({
            kind: 'Status',
            reason: 'NotFound',
            message: 'secrets "missing" not found',
          }),
        );
      } else {
        res.end(JSON.stringify({ kind: 'Secret', metadata: { name: 'x' } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('KubeClient', () => {
  const kube = () => new KubeClient({ server: base, token: () => 'sa-token' });

  it('sends the service-account token and the right patch content type', async () => {
    await kube().patch('/api/v1/namespaces/a/secrets/x', { metadata: { labels: { a: 'b' } } });
    expect(seen.at(-1)).toMatchObject({
      method: 'PATCH',
      type: 'application/merge-patch+json',
      auth: 'Bearer sa-token',
    });
  });

  it('turns API errors into KubeError with status and reason; find and delete treat 404 as absent', async () => {
    const error = await kube()
      .get('/api/v1/namespaces/a/secrets/missing')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KubeError);
    expect(error).toMatchObject({
      status: 404,
      reason: 'NotFound',
      message: 'secrets "missing" not found',
    });
    expect(isNotFound(error)).toBe(true);
    expect(await kube().find('/api/v1/namespaces/a/secrets/missing')).toBeNull();
    await expect(kube().delete('/api/v1/namespaces/a/secrets/missing')).resolves.toBeUndefined();
    expect(JSON.parse(seen.at(-1)!.body)).toMatchObject({ propagationPolicy: 'Background' });
  });
});
