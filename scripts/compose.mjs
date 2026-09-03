import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const commands = {
  up: ['up', '--detach', '--wait', '--wait-timeout', '180'],
  down: ['down', '--remove-orphans'],
  status: ['ps'],
  config: ['config', '--quiet'],
};
const command = commands[process.argv[2]];
if (!command || process.argv.length !== 3) throw new Error('Use compose.mjs up|down|status|config');
const result = spawnSync(
  'docker',
  [
    'compose',
    '--project-directory',
    '.',
    '--env-file',
    '.env',
    '-f',
    'infra/compose/compose.yaml',
    ...command,
  ],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit', windowsHide: true },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
