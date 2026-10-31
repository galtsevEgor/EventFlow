import { spawn } from 'node:child_process';
const mode = process.env.EVENTFLOW_PWA_PREVIEW === 'true' ? 'preview' : 'dev';
const child = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    ...(mode === 'preview' ? ['preview'] : []),
    '--host',
    '127.0.0.1',
    '--port',
    '3001',
    '--strictPort',
  ],
  { stdio: 'inherit', windowsHide: true },
);
child.once('error', () => {
  console.error('Organizer startup failed');
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
process.once('SIGINT', () => child.kill('SIGINT'));
process.once('SIGTERM', () => child.kill('SIGTERM'));
