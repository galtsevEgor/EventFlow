import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test(
  'S3 starts as an unprivileged user with private credentials owned by a Linux runner',
  { timeout: 45000 },
  () => {
    const options = { encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
    const config = JSON.parse(
      execFileSync(
        'docker',
        [
          'compose',
          '--project-directory',
          '.',
          '--env-file',
          '.env',
          '-f',
          'infra/compose/compose.yaml',
          'config',
          '--format',
          'json',
        ],
        options,
      ),
    );
    const service = config.services.s3;
    const name = `eventflow-s3-permissions-${randomUUID()}`;
    const mounts = service.volumes.filter(
      (volume) => volume.type === 'bind' && volume.target !== '/etc/seaweedfs/s3.json',
    );
    try {
      const result = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--name',
          name,
          '--network',
          'none',
          ...mounts.flatMap((volume) => [
            '--mount',
            `type=bind,source=${volume.source},target=${volume.target},readonly`,
          ]),
          ...service.tmpfs.flatMap((mount) => ['--tmpfs', mount]),
          '--entrypoint',
          'sh',
          '-i',
          service.image,
          '-s',
          '--',
          ...service.entrypoint,
          ...service.command,
        ],
        {
          ...options,
          input: readFileSync(new URL('./s3-permissions.sh', import.meta.url), 'utf8'),
          timeout: 38000,
        },
      );
      assert.equal(result.error, undefined, 'Docker startup probe did not complete.');
      assert.equal(
        result.status,
        0,
        `S3 Linux permissions probe failed:\n${result.stdout}\n${result.stderr}`,
      );
      assert.match(result.stdout, /Unprivileged S3 is ready/);
    } finally {
      spawnSync('docker', ['rm', '--force', name], options);
    }
  },
);
