import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const commands = {
  up: ['up', '--detach'],
  down: ['stop'],
  status: ['ps'],
  check: ['config', '--quiet'],
};
const command = commands[process.argv[2]];
if (!command || process.argv.length !== 3)
  throw new Error('Use observability up|down|status|check');
const revision = createHash('sha256');
for (const path of readdirSync('infra/observability', { recursive: true })
  .filter((path) => /\.(yaml|json)$/.test(path))
  .sort()) {
  revision.update(path.replaceAll('\\', '/'));
  revision.update(readFileSync(resolve('infra/observability', path)));
}
const composeEnvironment = {
  ...process.env,
  EVENTFLOW_OBSERVABILITY_CONFIG_SHA: revision.digest('hex'),
};
mkdirSync('work/observability', { recursive: true });
const env = 'work/observability/.env';
if (!existsSync(env))
  writeFileSync(env, `GRAFANA_ADMIN_PASSWORD=${randomBytes(32).toString('base64url')}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
const result = spawnSync(
  'docker',
  [
    'compose',
    '--project-directory',
    '.',
    '--env-file',
    env,
    '-f',
    'infra/observability/compose.yaml',
    ...command,
  ],
  { stdio: 'inherit', windowsHide: true, env: composeEnvironment },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (process.argv[2] === 'check') {
  const config = spawnSync(
    'docker',
    [
      'compose',
      '--project-directory',
      '.',
      '--env-file',
      env,
      '-f',
      'infra/observability/compose.yaml',
      'config',
      '--format',
      'json',
    ],
    { encoding: 'utf8', windowsHide: true, env: composeEnvironment },
  );
  if (config.error || config.status !== 0)
    throw new Error('Cannot resolve observability configuration');
  const image = JSON.parse(config.stdout).services.prometheus.image;
  for (const args of [
    ['check', 'rules', 'alerts.yaml', 'deployments.yaml'],
    ['test', 'rules', 'alerts.test.yaml'],
  ]) {
    const check = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--volume',
        `${resolve('infra/observability')}:/config:ro`,
        '--workdir',
        '/config',
        '--entrypoint',
        '/bin/promtool',
        image,
        ...args,
      ],
      { stdio: 'inherit', windowsHide: true },
    );
    if (check.error || check.status !== 0) throw new Error('Observability rule validation failed');
  }
}
if (process.argv[2] === 'up') {
  for (const [name, url] of Object.entries({
    collector: 'http://127.0.0.1:13133',
    tempo: 'http://127.0.0.1:13200/ready',
    prometheus: 'http://127.0.0.1:19090/-/ready',
    grafana: 'http://127.0.0.1:13000/api/health',
  })) {
    const deadline = Date.now() + 60000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
        ready = response.ok;
        await response.body.cancel();
      } catch {
        /* Dependencies can still be starting. */
      }
      if (!ready) await delay(500);
    }
    if (!ready) throw new Error(`${name} did not become ready`);
    console.log(`${name} ready`);
  }
}
