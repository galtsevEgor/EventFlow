import { createServer } from 'node:http';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createAdmission } from './gateway-limits.mjs';
const updatesPath =
  /^\/api\/v1\/(?:sales\/[a-f0-9-]{36}\/updates|orders\/[a-f0-9-]{36}\/updates|organizations\/[a-f0-9-]{36}\/events\/[a-f0-9-]{36}\/orders\/updates)$/i;

export function createGateway({
  bff = 'http://127.0.0.1:4000',
  organizer = 'http://127.0.0.1:3001',
  storefront = 'http://127.0.0.1:3000',
  observe,
  limits,
} = {}) {
  const admit = createAdmission(limits);
  function proxy(target, stream = false) {
    return createProxyMiddleware({
      target,
      changeOrigin: false,
      proxyTimeout: stream ? 0 : 15_000,
      on: {
        proxyReq: (upstream, _request, response) => {
          if (stream) response.once('close', () => upstream.destroy());
        },
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
    updates = proxy(bff, true),
    workspace = proxy(organizer),
    publicSite = proxy(storefront);
  const route = (url) =>
    updatesPath.test(url)
      ? updates
      : url.startsWith('/api/v1/')
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
    const group = updatesPath.test(path)
      ? 'stream'
      : path === '/api/v1/webhooks/stripe'
        ? 'webhook'
        : path.startsWith('/api/v1/')
          ? 'api'
          : path.startsWith('/organizer/') || path.startsWith('/_next/static/')
            ? null
            : 'ssr';
    if (!admit(request, response, group)) return;
    void route(path)(request, response);
  });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://gateway');
    const collaboration =
      /^\/api\/v1\/organizations\/[a-f0-9-]{36}\/events\/[a-f0-9-]{36}\/collaboration\/socket$/i.test(
        url.pathname,
      );
    if (
      url.pathname.startsWith('/internal/') ||
      (url.pathname.startsWith('/api/') && (!collaboration || url.search))
    ) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    route(url.pathname).upgrade(request, socket, head);
  });
  return server;
}
