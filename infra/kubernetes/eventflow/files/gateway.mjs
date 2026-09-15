import { createGateway } from '/app/scripts/gateway.mjs';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';

const gateway = createGateway({
  bff: 'http://bff:4000',
  organizer: 'http://organizer:3001',
  storefront: 'http://storefront:3000',
});
const active = process.env.EVENTFLOW_DEPLOYMENT;
const retained = process.env.EVENTFLOW_RETAINED_DEPLOYMENT;

async function asset(request, response) {
  const url = new URL(request.url, 'http://gateway');
  const version = url.searchParams.get('dpl');
  const path = url.pathname + url.search;
  const from = (service) =>
    fetch(new URL(path, `http://${service}:3000`), {
      method: request.method,
      headers: { 'accept-encoding': 'identity' },
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
  let useRetained = Boolean(retained && version === retained);
  let result = await from(useRetained ? 'storefront-retained' : 'storefront');
  if (!version && retained && result.status === 404) {
    await result.body?.cancel();
    result = await from('storefront-retained');
    useRetained = true;
  }
  for (const name of ['content-type', 'cache-control', 'etag', 'last-modified']) {
    const value = result.headers.get(name);
    if (value) response.setHeader(name, value);
  }
  const deployment = useRetained ? retained : active;
  if (deployment) response.setHeader('x-eventflow-asset-deployment', deployment);
  response.writeHead(result.status);
  if (result.body) {
    const body = Readable.fromWeb(result.body);
    body.on('error', () => response.destroy());
    response.on('close', () => body.destroy());
    body.pipe(response);
  } else response.end();
}

const server = createServer((request, response) => {
  if (['GET', 'HEAD'].includes(request.method) && request.url.startsWith('/_next/static/')) {
    void asset(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else response.writeHead(503).end();
    });
  } else gateway.emit('request', request, response);
});
server.on('upgrade', (...args) => gateway.emit('upgrade', ...args));
server.listen(8080, '0.0.0.0');
process.on('SIGTERM', () => {
  server.close();
  setTimeout(() => server.closeAllConnections(), 8000).unref();
});
