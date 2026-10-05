import { openSync, closeSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { output, run } from './local.mjs';
const migrationReviews = JSON.parse(
  readFileSync(new URL('../../config/migration-upgrades.json', import.meta.url), 'utf8'),
);
export function migrationHash(sql) {
  return createHash('sha256').update(sql.replaceAll('\r\n', '\n')).digest('hex');
}

export function assertUpgrade(previous, next, reviews = migrationReviews) {
  for (const [path, sql] of previous)
    if (next.get(path) !== sql)
      throw new Error(`Applied migration changed or disappeared: ${path}`);
  for (const [path, sql] of next) {
    if (previous.has(path)) continue;
    try {
      assertExpansion(new Map(), new Map([[path, sql]]));
    } catch (error) {
      const review = reviews[path];
      if (typeof review?.backwardCompatible !== 'boolean' || review.sha256 !== migrationHash(sql))
        throw error;
    }
  }
}

export function assertApplicationSchema(application, schema, reviews = migrationReviews) {
  assertUpgrade(application, schema, reviews);
  for (const [path, sql] of schema) {
    const review = reviews[path];
    if (
      review?.backwardCompatible === false &&
      review.sha256 === migrationHash(sql) &&
      !application.has(path)
    )
      throw new Error(`Application cannot read the upgraded schema: ${path}`);
  }
}

export function migrationTree(id) {
  if (!/^[a-f0-9]{40}$/.test(id)) throw new Error('Invalid migration tree ID.');
  const paths = output('git', ['ls-tree', '-r', '--name-only', id, '--', 'services'])
    .split(/\r?\n/)
    .filter((path) =>
      /^services\/(catalog|booking|payments|tickets)\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(
        path,
      ),
    );
  return new Map(
    paths.map((path) => [
      path,
      run('git', ['show', `${id}:${path}`], {
        stdio: ['ignore', 'pipe', 'inherit'],
        encoding: 'utf8',
      }),
    ]),
  );
}

export function assertExpansion(previous, next) {
  for (const [path, sql] of previous) {
    if (next.get(path) !== sql)
      throw new Error(`Applied migration changed or disappeared: ${path}`);
  }
  for (const [path, sql] of next) {
    if (previous.has(path)) continue;
    const statements = sql
      .replace(/^\s*--.*$/gm, '')
      .split(';')
      .map((line) => line.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    if (
      !statements.length ||
      !statements.every(
        (statement) =>
          /^CREATE INDEX (?:IF NOT EXISTS )?"[a-z0-9_]+" ON "[a-z0-9_]+"\s*\("[a-z0-9_]+"(?:,\s*"[a-z0-9_]+")*\)(?: WHERE "[a-z0-9_]+" IN \('[a-z0-9_]+'(?:,\s*'[a-z0-9_]+')*\))?$/i.test(
            statement,
          ) ||
          /^ALTER TABLE "[a-z0-9_]+" ADD COLUMN (?:"[a-z0-9_]+"|[a-z_][a-z0-9_]*) (?:TEXT|INTEGER|BOOLEAN|BYTEA|UUID|VARCHAR\([1-9][0-9]{0,3}\)|TIMESTAMPTZ(?:\([0-6]\))?)$/i.test(
            statement,
          ),
      )
    )
      throw new Error(`Migration needs an explicit compatibility review: ${path}`);
  }
}

export async function withEnvironmentLock(target, operation) {
  const path = resolve(target.directory, 'deployment.lock');
  let lock;
  try {
    lock = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(`${target.name} is locked by another release operation.`, { cause: error });
    throw error;
  }
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await operation();
  } finally {
    closeSync(lock);
    unlinkSync(path);
  }
}

export async function replaceApplication(start, recover) {
  try {
    await start();
  } catch (error) {
    try {
      await recover();
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError], 'Rollout and recovery both failed.', {
        cause: recoveryError,
      });
    }
    throw error;
  }
}
