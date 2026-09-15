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
  writeJson,
} from './release/local.mjs';

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
  const release = manifest(id);
  prepare(target, release.image);
  await rollOut(target, release.image);
  writeJson(resolve(target.directory, 'deployment.json'), {
    id,
    image: release.image,
    verifiedAt: new Date().toISOString(),
  });
  console.log(`${target.name}: ${id} is ready at ${target.origin}`);
}

const [command, first, second, ...extra] = process.argv.slice(2);
if (!extra.length && command === 'build' && !first) {
  const release = build();
  console.log(`Release ${release.id} ${release.image}`);
} else if (!extra.length && command === 'deploy' && first === 'staging' && second) {
  await deploy(environment(first), second);
} else if (!extra.length && command === 'promote' && first && !second) {
  if (active(environment('staging'))?.id !== first)
    throw new Error('Only the verified staging release can be promoted.');
  await deploy(environment('demo'), first);
} else if (!extra.length && ['status', 'stop'].includes(command) && first && !second) {
  const target = environment(first);
  compose(target, command === 'status' ? ['ps'] : ['stop'], { image: active(target)?.image });
} else {
  throw new Error('Use release build | deploy staging ID | promote ID | status ENV | stop ENV.');
}
