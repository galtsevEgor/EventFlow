import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  active,
  compose,
  environment,
  images,
  manifest,
  output,
  prepare,
  rollOut,
  run,
  startDependencies,
  waitFor,
  writeJson,
} from './release/local.mjs';
import {
  assertUpgrade,
  assertApplicationSchema,
  migrationTree,
  replaceApplication,
  withEnvironmentLock,
} from './release/compatibility.mjs';
import { backup, restore } from './release/backup.mjs';
import { telemetrySettings } from './release/telemetry.mjs';

function build() {
  run('git', ['diff', '--quiet']);
  if (output('git', ['ls-files', '--others', '--exclude-standard']))
    throw new Error('Stage the release sources or commit them before building.');
  const id = output('git', ['write-tree']);
  const directory = resolve(images, id);
  const path = resolve(directory, 'manifest.json');
  if (existsSync(path)) return manifest(id);
  mkdirSync(directory, { recursive: true });
  const source = run('git', ['archive', '--format=tar', id], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const tag = `eventflow-release:${id}`;
  run(
    'docker',
    [
      'build',
      '--label',
      `org.opencontainers.image.revision=${id}`,
      '--build-arg',
      `EVENTFLOW_BUILD_ID=${id}`,
      '-f',
      'infra/release/Dockerfile',
      '-t',
      tag,
      '-',
    ],
    {
      input: source,
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  );
  const image = output('docker', ['image', 'inspect', '--format', '{{.Id}}', tag]);
  const sbom = output('docker', [
    'run',
    '--rm',
    '--network',
    'none',
    image,
    'node',
    'scripts/release/sbom.mjs',
  ]);
  if (!JSON.parse(sbom).components?.length) throw new Error('No packages found in image SBOM.');
  writeFileSync(resolve(directory, 'sbom.cdx.json'), sbom);
  const release = {
    id,
    image,
    version: JSON.parse(readFileSync('package.json', 'utf8')).version,
    sbomSha256: createHash('sha256').update(sbom).digest('hex'),
    createdAt: new Date().toISOString(),
  };
  writeJson(path, release);
  return release;
}

async function deploy(target, id) {
  await withEnvironmentLock(target, async () => {
    const release = manifest(id);
    const installed = active(target);
    const previous = installed ? manifest(installed.id) : null;
    const schemaPath = resolve(target.directory, 'schema.json');
    const schemaId = existsSync(schemaPath)
      ? JSON.parse(readFileSync(schemaPath, 'utf8')).id
      : installed?.id;
    if (id !== previous?.id) {
      if (previous && release.createdAt < previous.createdAt)
        throw new Error('Use rollback for an older release.');
      if (schemaId) assertUpgrade(migrationTree(schemaId), migrationTree(id));
      // Record intent first because a migration may succeed in one DB before another fails.
      writeJson(schemaPath, { id });
      prepare(target, release.image);
    } else {
      startDependencies(target, release.image);
    }
    await replaceApplication(
      () => rollOut(target, release.image),
      async () => {
        let compatible = false;
        if (previous) {
          try {
            assertApplicationSchema(migrationTree(previous.id), migrationTree(id));
            compatible = true;
          } catch {
            console.warn(
              'The previous application cannot read the upgraded schema; use a forward fix or the pre-upgrade backup.',
            );
          }
        }
        if (previous && previous.id !== id && compatible) {
          await rollOut(target, previous.image);
          console.warn(`Restored previous application ${previous.id}; expanded schema retained.`);
        } else compose(target, ['stop', 'app'], { image: release.image });
      },
    );
    recordDeployment(target, release, previous?.id === id ? installed.previous : previous?.id);
  });
}

function recordDeployment(target, release, previous) {
  writeJson(resolve(target.directory, 'deployment.json'), {
    id: release.id,
    image: release.image,
    previous: previous ?? null,
    verifiedAt: new Date().toISOString(),
  });
  console.log(`${target.name}: ${release.id} is ready at ${target.origin}`);
}

async function rollback(target) {
  await withEnvironmentLock(target, async () => {
    const installed = active(target);
    if (!installed?.previous) throw new Error('There is no verified previous application.');
    const current = manifest(installed.id);
    const previous = manifest(installed.previous);
    const schemaPath = resolve(target.directory, 'schema.json');
    const schemaId = existsSync(schemaPath)
      ? JSON.parse(readFileSync(schemaPath, 'utf8')).id
      : current.id;
    assertApplicationSchema(migrationTree(previous.id), migrationTree(schemaId));
    startDependencies(target, current.image);
    await replaceApplication(
      () => rollOut(target, previous.image),
      () => rollOut(target, current.image),
    );
    recordDeployment(target, previous, current.id);
  });
}

const [command, first, second, ...extra] = process.argv.slice(2);
if (!extra.length && command === 'build' && !first) {
  const release = build();
  console.log(`Release ${release.id} ${release.image}`);
} else if (
  !extra.length &&
  command === 'telemetry' &&
  ['staging', 'demo'].includes(first) &&
  ['on', 'off'].includes(second)
) {
  const target = environment(first);
  await withEnvironmentLock(target, () => {
    writeFileSync(
      target.envPath,
      telemetrySettings(readFileSync(target.envPath, 'utf8'), first, second === 'on'),
      { mode: 0o600 },
    );
  });
  console.log(`${first}: telemetry ${second}; settings apply on the next deploy.`);
} else if (!extra.length && command === 'deploy' && first === 'staging' && second) {
  await deploy(environment(first), second);
} else if (!extra.length && command === 'promote' && first && !second) {
  if (active(environment('staging'))?.id !== first)
    throw new Error('Only the verified staging release can be promoted.');
  await deploy(environment('demo'), first);
} else if (!extra.length && command === 'rollback' && first && !second) {
  await rollback(environment(first));
} else if (
  !extra.length &&
  command === 'backup' &&
  ['staging', 'demo'].includes(first) &&
  !second
) {
  await backup(environment(first));
} else if (!extra.length && command === 'restore' && first && !second) {
  await restore(first);
} else if (!extra.length && command === 'monitor' && first && !second) {
  const target = environment(first);
  await withEnvironmentLock(target, async () => {
    const installed = active(target);
    if (!installed) throw new Error('Deploy the environment before starting its monitor.');
    const { image } = manifest(installed.id);
    compose(target, ['up', '-d', '--no-deps', 'monitor'], { image });
    await waitFor(target.monitor + '/api/status', 15000);
    console.log(`Monitor ready at ${target.monitor}`);
  });
} else if (!extra.length && ['status', 'stop'].includes(command) && first && !second) {
  const target = environment(first);
  if (command === 'status') compose(target, ['ps'], { image: active(target)?.image });
  else
    await withEnvironmentLock(target, () =>
      compose(target, ['stop'], { image: active(target)?.image }),
    );
} else {
  throw new Error(
    'Use release build | deploy staging ID | promote ID | rollback ENV | backup ENV | restore ID | monitor ENV | telemetry staging|demo on|off | status ENV | stop ENV.',
  );
}
