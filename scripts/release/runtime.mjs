import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createGateway } from '../gateway.mjs';
import { localServiceHost, localServiceOrigin, localServicePorts } from '../local-services.mjs';
import { traffic } from './traffic.mjs';

const applications = [
  ['bff', 'apps/bff', ['dist/main.js']],
  ...['catalog', 'booking', 'payments', 'tickets', 'search', 'analytics', 'waitlist'].map(
    (name) => [name, `services/${name}`, ['dist/main.js']],
  ),
  [
    'storefront',
    'apps/storefront',
    [
      'node_modules/next/dist/bin/next',
      'start',
      '--hostname',
      localServiceHost,
      '--port',
      String(localServicePorts.storefront),
    ],
  ],
  [
    'organizer',
    'apps/organizer',
    [
      'node_modules/vite/bin/vite.js',
      'preview',
      '--host',
      localServiceHost,
      '--port',
      String(localServicePorts.organizer),
      '--strictPort',
    ],
  ],
];
const appOrigin = new URL(process.env.PUBLIC_ORIGIN);
const identityOrigin = new URL(process.env.KEYCLOAK_URL);
if (
  [appOrigin, identityOrigin].some(
    ({ hostname, protocol }) => hostname !== localServiceHost || protocol !== 'http:',
  )
)
  throw new Error('Release runtime is restricted to loopback HTTP endpoints.');

const telemetry = traffic();
const gateway = createGateway({ observe: telemetry.observe });
const metrics = createServer((_req, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(telemetry.snapshot()));
});
const proxyIdentity = createProxyMiddleware({
  target: 'http://keycloak:8080',
  changeOrigin: false,
  proxyTimeout: 10000,
  on: { error: (_error, _request, response) => response.writeHead(503).end() },
});
const identity = createServer((req, res) => {
  void proxyIdentity(req, res);
});
const children = new Set();
let stopping = false;
function stop(failed = false) {
  if (stopping) return;
  stopping = true;
  process.exitCode = failed ? 1 : 0;
  for (const server of [gateway, identity, metrics]) {
    server.closeAllConnections();
    server.close();
  }
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 8000).unref();
}
for (const server of [gateway, identity, metrics]) server.on('error', () => stop(true));
gateway.listen(Number(appOrigin.port), '0.0.0.0');
identity.listen(Number(identityOrigin.port), '0.0.0.0');
metrics.listen(9101, '0.0.0.0');
for (const [name, cwd, args] of applications) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: {
      ...process.env,
      BFF_URL: process.env.BFF_URL ?? localServiceOrigin('bff'),
      HOST: localServiceHost,
      PORT: String(localServicePorts[name]),
    },
    stdio: 'inherit',
  });
  children.add(child);
  child.on('error', () => stop(true));
  child.on('exit', () => {
    children.delete(child);
    if (!stopping) {
      console.error(`Release service stopped: ${name}`);
      stop(true);
    }
  });
}
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
