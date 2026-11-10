import { createServer } from 'node:http';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createAdmission } from './gateway-limits.mjs';
import { localServiceOrigin } from './local-services.mjs';
const updatesPath =
  /^\/api\/v1\/(?:(?:sales|orders|waitlist)\/[a-f0-9-]{36}\/updates|organizations\/[a-f0-9-]{36}\/events\/[a-f0-9-]{36}\/orders\/updates)$/i;

const uuidSegment = '[a-f0-9-]{36}';
const eventScope = `organizations/${uuidSegment}/events/${uuidSegment}`;
const extendedApiRoutes = [
  { methods: ['POST'], path: /^\/api\/v1\/orders$/ },
  {
    methods: ['GET', 'POST'],
    path: new RegExp(`^/api/v1/(?:covers/${uuidSegment}|${eventScope}/cover)/?$`, 'i'),
  },
  { methods: ['GET', 'POST'], path: /^\/api\/v1\/offline-check-in\/(?:keys|sessions|sync)\/?$/ },
  {
    methods: ['GET'],
    path: new RegExp(
      `^/api/v1/(?:organizations/${uuidSegment}/analytics(?:/waitlist)?|analytics/search-quality)/?$`,
      'i',
    ),
  },
  {
    methods: ['GET', 'POST', 'PUT'],
    path: new RegExp(
      `^/api/v1/(?:waitlist(?:/${uuidSegment}(?:/cancel)?)?|events/${uuidSegment}/waitlist|${eventScope}/waitlist)/?$`,
      'i',
    ),
  },
];

function needsExtendedApiTimeout(method, path) {
  return extendedApiRoutes.some((route) => route.methods.includes(method) && route.path.test(path));
}

export function createGateway({
  bff = localServiceOrigin('bff'),
  organizer = localServiceOrigin('organizer'),
  storefront = localServiceOrigin('storefront'),
  observe,
  limits,
  proxyTimeouts = {},
} = {}) {
  const admit = createAdmission(limits);
  // The outer socket must stay open past the BFF's own deadline and response handling.
  const { standardMs = 15_000, extendedApiMs = 25_000 } = proxyTimeouts;
  if (
    ![standardMs, extendedApiMs].every((value) => Number.isSafeInteger(value) && value > 0) ||
    extendedApiMs <= standardMs
  )
    throw new Error('Invalid gateway proxy timeouts');
  function proxy(target, { timeoutMs = standardMs, stream = false } = {}) {
    return createProxyMiddleware({
      target,
      changeOrigin: false,
      proxyTimeout: stream ? 0 : timeoutMs,
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
    extendedApi = proxy(bff, { timeoutMs: extendedApiMs }),
    updates = proxy(bff, { stream: true }),
    workspace = proxy(organizer),
    publicSite = proxy(storefront);
  function route(path, method) {
    if (updatesPath.test(path)) return updates;
    if (path.startsWith('/api/v1/'))
      return needsExtendedApiTimeout(method, path) ? extendedApi : api;
    return path === '/organizer' || path.startsWith('/organizer/') ? workspace : publicSite;
  }
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
    void route(path, request.method)(request, response);
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
    route(url.pathname, request.method).upgrade(request, socket, head);
  });
  return server;
}
