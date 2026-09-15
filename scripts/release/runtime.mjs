import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createGateway } from '../gateway.mjs';

const applications = [
  ['bff', 'apps/bff', 4000, ['dist/main.js']],
  ...['catalog', 'booking', 'payments', 'tickets'].map((name, index) => [
    name,
    `services/${name}`,
    4001 + index,
    ['dist/main.js'],
  ]),
  [
    'storefront',
    'apps/storefront',
    3000,
    ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3000'],
  ],
  [
    'organizer',
    'apps/organizer',
    3001,
    [
      'node_modules/vite/bin/vite.js',
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      '3001',
      '--strictPort',
    ],
  ],
];
const appOrigin = new URL(process.env.PUBLIC_ORIGIN);
const identityOrigin = new URL(process.env.KEYCLOAK_URL);
if (
  [appOrigin, identityOrigin].some(
    ({ hostname, protocol }) => hostname !== '127.0.0.1' || protocol !== 'http:',
  )
)
  throw new Error('Release runtime is restricted to loopback HTTP endpoints.');

const gateway = createGateway();
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
  for (const server of [gateway, identity]) {
    server.closeAllConnections();
    server.close();
  }
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 8000).unref();
}
for (const server of [gateway, identity]) server.on('error', () => stop(true));
gateway.listen(Number(appOrigin.port), '0.0.0.0');
identity.listen(Number(identityOrigin.port), '0.0.0.0');
for (const [name, cwd, port, args] of applications) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
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
