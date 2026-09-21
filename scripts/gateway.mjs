import { createServer } from 'node:http';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createAdmission } from './gateway-limits.mjs';

export function createGateway({
  bff = 'http://127.0.0.1:4000',
  organizer = 'http://127.0.0.1:3001',
  storefront = 'http://127.0.0.1:3000',
  observe,
  limits,
} = {}) {
  const admit = createAdmission(limits);
  function proxy(target) {
    return createProxyMiddleware({
      target,
      changeOrigin: false,
      proxyTimeout: 15_000,
      on: {
        error: (_error, _request, response) => {
          if ('writeHead' in response && !response.headersSent) {
            response.writeHead(503, {
              'content-type': 'application/json',
              'cache-control': 'no-store',
              'retry-after': '1',
            });
            response.end(
              JSON.stringify({
                code: 'UNAVAILABLE',
                message: 'Service unavailable',
                retryable: true,
              }),
            );
          } else response.destroy();
        },
        proxyRes: (response) => {
          response.headers['referrer-policy'] = 'no-referrer';
          response.headers['x-content-type-options'] = 'nosniff';
          response.headers['x-frame-options'] = 'DENY';
        },
      },
    });
  }
  const api = proxy(bff),
    workspace = proxy(organizer),
    publicSite = proxy(storefront);
  const route = (url) =>
    url.startsWith('/api/v1/')
      ? api
      : url === '/organizer' || url.startsWith('/organizer/')
        ? workspace
        : publicSite;
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://gateway').pathname;
    if (
      ['GET', 'HEAD'].includes(request.method) &&
      ['/health/live', '/health/ready'].includes(path)
    ) {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ service: 'gateway', status: 'ready' }));
      return;
    }
    if (observe && request.url.startsWith('/api/v1/')) {
      const started = performance.now();
      response.once('finish', () => observe(response.statusCode, performance.now() - started));
    }
    if (request.url === '/organizer') {
      response.writeHead(308, { location: '/organizer/' });
      response.end();
      return;
    }
    if (request.url.startsWith('/internal/')) {
      response.writeHead(404);
      response.end();
      return;
    }
    const group =
      path === '/api/v1/webhooks/stripe'
        ? 'webhook'
        : path.startsWith('/api/v1/')
          ? 'api'
          : path.startsWith('/organizer/') || path.startsWith('/_next/static/')
            ? null
            : 'ssr';
    if (!admit(request, response, group)) return;
    void route(request.url)(request, response);
  });
  server.on('upgrade', (request, socket, head) =>
    route(request.url).upgrade(request, socket, head),
  );
  return server;
}
