import { execFile, spawn } from 'node:child_process';
import { createGateway } from './gateway.mjs';

const origin = new URL(process.env.PUBLIC_ORIGIN);
if (origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:')
  throw new Error('Local development requires an HTTP PUBLIC_ORIGIN on 127.0.0.1');
const gateway = createGateway();
await new Promise((done, reject) => {
  gateway.once('error', reject);
  gateway.listen(Number(origin.port || 80), '127.0.0.1', done);
});
const child = spawn(
  process.execPath,
  ['node_modules/turbo/bin/turbo', 'run', 'dev', '--env-mode=loose'],
  {
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, BFF_URL: process.env.BFF_URL ?? 'http://127.0.0.1:4000' },
  },
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  gateway.closeAllConnections();
  gateway.close();
  if (process.platform === 'win32' && child.pid && child.exitCode === null) {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else child.kill('SIGTERM');
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
child.once('error', () => {
  console.error('Development runner could not start');
  process.exitCode = 1;
  stop();
});
child.once('exit', (code) => {
  process.exitCode = code ?? 0;
  stop();
});
console.log(`EventFlow: ${origin.origin}`);
