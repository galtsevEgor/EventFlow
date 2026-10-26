import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  active,
  compose,
  composeOutput,
  environment,
  manifest,
  output,
  rollOut,
  root,
  run,
  startDependencies,
  waitFor,
  writeJson,
} from './local.mjs';
import { withEnvironmentLock } from './compatibility.mjs';

const databases = [
  'catalog',
  'booking',
  'payments',
  'tickets',
  'analytics',
  'waitlist',
  'keycloak',
];
const optionalDatabases = new Set(['analytics', 'waitlist']);
const names = (databases) => [
  ...databases.map((name) => name + '.dump'),
  'assets.tgz',
  'settings.env',
  'users.json',
];
export function backupDatabaseNames(index) {
  const selected =
    index.databases === undefined
      ? databases.filter((name) => !optionalDatabases.has(name))
      : index.databases;
  if (
    !Array.isArray(selected) ||
    new Set(selected).size !== selected.length ||
    selected.some((name) => !databases.includes(name)) ||
    databases
      .filter((name) => !optionalDatabases.has(name))
      .some((name) => !selected.includes(name))
  )
    throw new Error('Invalid backup database set');
  return databases.filter((name) => selected.includes(name));
}
const maxBytes = 128 * 1024 * 1024;
const capture = { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: maxBytes };
const feed = (input) => ({ input, stdio: ['pipe', 'ignore', 'inherit'] });

export function encryptBackup(key, context, bytes) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const payload = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), payload]);
}

export function decryptBackup(key, context, bytes) {
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
}

function key(create) {
  const path = resolve(root, 'backup.key');
  if (create && !existsSync(path)) {
    try {
      writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const result = readFileSync(path);
  if (result.length !== 32) throw new Error('Invalid local backup key.');
  return result;
}

function assetsContainer(target) {
  const id = composeOutput(target, ['ps', '-a', '-q', 's3']);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('S3 container not found.');
  return id;
}

function postgresImage(target) {
  const id = composeOutput(target, ['ps', '-q', 'postgres']);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('PostgreSQL container not found.');
  return output('docker', ['inspect', '--format', '{{.Image}}', id]);
}

function requireQuiescentBroker(target) {
  const queues = JSON.parse(
    composeOutput(target, [
      'exec',
      '-T',
      'rabbitmq',
      'rabbitmqctl',
      '-q',
      'list_queues',
      'name',
      'messages',
      '--formatter=json',
    ]),
  );
  if (!Array.isArray(queues) || queues.some(({ messages }) => messages !== 0))
    throw new Error(
      'Broker still contains messages. Resolve the backlog before taking a consistent backup.',
    );
}

export async function backup(target) {
  return withEnvironmentLock(target, async () => {
    const installed = active(target);
    if (!installed) throw new Error('Deploy and verify the source environment first.');
    const { image } = manifest(installed.id);
    await waitFor(target.origin + '/api/v1/events', 5000);
    const id = randomUUID();
    const directory = resolve(root, 'backups', id);
    const secret = key(true);
    mkdirSync(directory, { recursive: true });
    const save = (name, content) => {
      if (content.length > maxBytes) throw new Error('Local backup size limit exceeded.');
      writeFileSync(
        resolve(directory, name + '.enc'),
        encryptBackup(secret, id + '/' + name, content),
        { mode: 0o600 },
      );
    };
    const started = performance.now();
    try {
      compose(target, ['stop', 'app', 'keycloak', 's3'], { image });
      requireQuiescentBroker(target);
      const snapshotAt = new Date().toISOString();
      const available = composeOutput(
        target,
        [
          'exec',
          '-T',
          'postgres',
          'psql',
          '-U',
          'eventflow_admin',
          '-d',
          'eventflow_admin',
          '-Atc',
          "SELECT datname FROM pg_database WHERE datname IN ('analytics','waitlist')",
        ],
        { image },
      ).split(/\s+/);
      const snapshotDatabases = databases.filter(
        (name) => !optionalDatabases.has(name) || available.includes(name),
      );
      for (const name of snapshotDatabases) {
        save(
          name + '.dump',
          compose(
            target,
            ['exec', '-T', 'postgres', 'pg_dump', '-U', 'eventflow_admin', '-Fc', name],
            capture,
          ),
        );
      }
      save(
        'assets.tgz',
        run(
          'docker',
          [
            'run',
            '--rm',
            '--network',
            'none',
            '--volumes-from',
            assetsContainer(target) + ':ro',
            '--entrypoint',
            'tar',
            postgresImage(target),
            '-czf',
            '-',
            '-C',
            '/data',
            '.',
          ],
          capture,
        ),
      );
      save('settings.env', readFileSync(target.envPath));
      save('users.json', readFileSync(resolve(target.directory, 'work/local/demo-users.json')));
      const schemaPath = resolve(target.directory, 'schema.json');
      const schemaId = existsSync(schemaPath)
        ? JSON.parse(readFileSync(schemaPath, 'utf8')).id
        : installed.id;
      save(
        'index.json',
        Buffer.from(
          JSON.stringify({
            format: 1,
            databases: snapshotDatabases,
            id,
            source: target.name,
            releaseId: installed.id,
            schemaId,
            snapshotAt,
          }),
        ),
      );
    } finally {
      compose(target, ['start', 's3', 'keycloak', 'app'], { image });
      await rollOut(target, image);
    }
    console.log(`Backup ${id} completed in ${Math.round(performance.now() - started)} ms.`);
    return id;
  });
}

export async function restore(id) {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id))
    throw new Error('Invalid backup ID.');
  const target = environment('recovery');
  await withEnvironmentLock(target, async () => {
    const project = 'eventflow-release-recovery';
    if (
      active(target) ||
      composeOutput(target, ['ps', '-a', '-q']) ||
      output('docker', [
        'volume',
        'ls',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${project}`,
      ])
    )
      throw new Error(
        'Recovery already has containers or volumes. Restore requires an empty recovery environment.',
      );
    const started = performance.now();
    const restoreStartedAt = new Date().toISOString();
    const directory = resolve(root, 'backups', id);
    const secret = key(false);
    const load = (name) => {
      const path = resolve(directory, name + '.enc');
      if (statSync(path).size > maxBytes + 28) throw new Error('Local backup size limit exceeded.');
      return decryptBackup(secret, id + '/' + name, readFileSync(path));
    };
    const index = JSON.parse(load('index.json').toString('utf8'));
    if (
      index.format !== 1 ||
      index.id !== id ||
      !/^[a-f0-9]{40}$/.test(index.schemaId) ||
      !Number.isFinite(Date.parse(index.snapshotAt))
    )
      throw new Error('Invalid backup manifest.');
    const release = manifest(index.releaseId);
    // Authenticate all entries before starting a container or replacing a recovery secret.
    const snapshotDatabases = backupDatabaseNames(index);
    const entries = new Map(names(snapshotDatabases).map((name) => [name, load(name)]));
    writeFileSync(target.envPath, entries.get('settings.env'), { mode: 0o600 });
    const recovery = environment('recovery');
    writeFileSync(
      resolve(recovery.directory, 'work/local/demo-users.json'),
      entries.get('users.json'),
      { mode: 0o600 },
    );
    const { image } = release;
    compose(recovery, ['up', '-d', '--wait', 'postgres', 'redis', 'rabbitmq', 'mailpit'], {
      image,
    });
    for (const name of snapshotDatabases) {
      compose(
        recovery,
        [
          'exec',
          '-T',
          'postgres',
          'pg_restore',
          '--exit-on-error',
          '--no-owner',
          '--no-privileges',
          '-U',
          name,
          '-d',
          name,
        ],
        {
          ...feed(entries.get(name + '.dump')),
          image,
        },
      );
    }
    compose(recovery, ['create', 's3'], { image });
    run(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '--network',
        'none',
        '--volumes-from',
        assetsContainer(recovery),
        '--entrypoint',
        'sh',
        postgresImage(recovery),
        '-ec',
        'test -z "$(ls -A /data)" && exec tar -xzf - -C /data',
      ],
      feed(entries.get('assets.tgz')),
    );
    startDependencies(recovery, image);
    await rollOut(recovery, image);
    writeJson(resolve(recovery.directory, 'schema.json'), { id: index.schemaId });
    writeJson(resolve(recovery.directory, 'deployment.json'), {
      id: release.id,
      image,
      previous: null,
      verifiedAt: new Date().toISOString(),
    });
    const result = {
      backupId: id,
      snapshotAt: index.snapshotAt,
      restoreStartedAt,
      snapshotAgeMs: Date.parse(restoreStartedAt) - Date.parse(index.snapshotAt),
      smokeRtoMs: Math.round(performance.now() - started),
    };
    writeJson(resolve(recovery.directory, 'restore.json'), result);
    console.log(JSON.stringify(result));
  });
}
