import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { initializeEnvironment } from '../local-env.mjs';

export const root = resolve('work/release');
export const images = resolve(root, 'images');
const releaseId = /^[a-f0-9]{40}$/;
const imageId = /^sha256:[a-f0-9]{64}$/;
const ports = {
  staging: [28000, 28080, 28025],
  demo: [38000, 38080, 38025],
  recovery: [48000, 48080, 48025],
};
export const dependencies = ['postgres', 'redis', 'rabbitmq', 'keycloak', 's3', 'mailpit'];

export function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    windowsHide: true,
    stdio: 'inherit',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(`${program} ${args[0]} failed (exit ${result.status ?? 'unknown'})`, {
      cause: result.error,
    });
  return result.stdout;
}

export function output(program, args, options = {}) {
  return run(program, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    ...options,
  }).trim();
}

export function writeJson(path, object) {
  writeFileSync(path + '.tmp', JSON.stringify(object, null, 2) + '\n', { mode: 0o600 });
  renameSync(path + '.tmp', path);
}

export function environment(name) {
  if (!Object.hasOwn(ports, name)) throw new Error('Choose staging, demo or recovery.');
  const directory = resolve(root, name);
  const envPath = resolve(directory, '.env');
  mkdirSync(directory, { recursive: true });
  initializeEnvironment(directory);
  const [web, identity, mail] = ports[name];
  return {
    name,
    directory,
    envPath,
    origin: `http://127.0.0.1:${web}`,
    identity: `http://127.0.0.1:${identity}`,
    env: {
      ...process.env,
      ...parseEnv(readFileSync(envPath, 'utf8')),
      RELEASE_PORT: String(web),
      RELEASE_IDENTITY_PORT: String(identity),
      RELEASE_MAIL_PORT: String(mail),
      RELEASE_DATA_DIR: resolve(directory, 'work').replaceAll('\\', '/'),
      RELEASE_MAIL_DISABLED: name === 'recovery' ? 'true' : 'false',
    },
  };
}

export function compose(target, args, options = {}) {
  return run(
    'docker',
    [
      'compose',
      '--project-name',
      `eventflow-release-${target.name}`,
      '--project-directory',
      '.',
      '--env-file',
      target.envPath,
      '-f',
      'infra/compose/compose.yaml',
      '-f',
      'infra/release/compose.yaml',
      ...args,
    ],
    {
      ...options,
      env: { ...target.env, RELEASE_IMAGE: options.image ?? 'eventflow-release:unselected' },
    },
  );
}

export function composeOutput(target, args, options = {}) {
  return compose(target, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  }).trim();
}

export function active(target) {
  const path = resolve(target.directory, 'deployment.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

export function manifest(id) {
  if (!releaseId.test(id)) throw new Error('Use the 40-character release ID.');
  const directory = resolve(images, id);
  const result = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'));
  const sbomHash = createHash('sha256')
    .update(readFileSync(resolve(directory, 'sbom.cdx.json')))
    .digest('hex');
  if (
    result.id !== id ||
    !imageId.test(result.image) ||
    result.sbomSha256 !== sbomHash ||
    output('docker', [
      'image',
      'inspect',
      '--format',
      '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}',
      result.image,
    ]) !== `${result.image} ${id}`
  )
    throw new Error('Release image does not match the manifest.');
  return result;
}

export async function waitFor(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // The local container may still be starting.
    }
    await delay(1000);
  }
  throw new Error(`Probe timed out: ${new URL(url).pathname}`);
}

export function startDependencies(target, image) {
  compose(target, ['up', '-d', '--wait', '--wait-timeout', '150', ...dependencies], { image });
}

export function prepare(target, image) {
  startDependencies(target, image);
  compose(target, ['run', '--rm', '--no-deps', 'migrate'], { image });
}

export async function rollOut(target, image) {
  compose(target, ['up', '-d', '--no-deps', 'app'], { image });
  await waitFor(target.identity + '/realms/master/.well-known/openid-configuration');
  compose(
    target,
    ['exec', '-T', '-e', 'KEYCLOAK_ADMIN_PASSWORD', 'app', 'node', 'scripts/keycloak-seed.mjs'],
    { image },
  );
  compose(target, ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '100', 'app'], { image });
  await waitFor(target.origin + '/api/v1/events');
  const container = composeOutput(target, ['ps', '-q', 'app'], { image });
  if (!container || output('docker', ['inspect', '--format', '{{.Image}}', container]) !== image)
    throw new Error('Running image does not match the release manifest.');
}
