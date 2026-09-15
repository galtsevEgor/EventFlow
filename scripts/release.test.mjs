import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertExpansion,
  replaceApplication,
  withEnvironmentLock,
} from './release/compatibility.mjs';

test('deployment lock excludes overlap and is released even after failure', async () => {
  const target = { name: 'fixture', directory: mkdtempSync(join(tmpdir(), 'eventflow-lock-')) };
  try {
    await assert.rejects(
      withEnvironmentLock(target, async () => {
        await assert.rejects(
          withEnvironmentLock(target, () => assert.fail('second writer entered')),
          /locked/,
        );
        throw new Error('migration failed');
      }),
      /migration failed/,
    );
    await withEnvironmentLock(target, () => true);
  } finally {
    rmSync(join(target.directory, 'deployment.lock'), { force: true });
    rmdirSync(target.directory);
  }
});

test('applied migrations are immutable and automatic rollback accepts only reviewed additive SQL forms', () => {
  const old = new Map([['init', 'CREATE TABLE baseline (id uuid);']]);
  const extend = (sql) => new Map([...old, ['next', sql]]);
  assert.doesNotThrow(() =>
    assertExpansion(old, extend('CREATE INDEX "age_idx" ON "Ticket" ("usedAt");')),
  );
  assert.doesNotThrow(() =>
    assertExpansion(old, extend('ALTER TABLE "Ticket" ADD COLUMN "note" TEXT;')),
  );
  assert.throws(
    () => assertExpansion(old, extend('ALTER TABLE "Ticket" DROP COLUMN "usedAt";')),
    /review/,
  );
  assert.throws(
    () => assertExpansion(old, extend('ALTER TABLE "Ticket" ADD COLUMN "required" TEXT NOT NULL;')),
    /review/,
  );
  assert.throws(() => assertExpansion(old, new Map([['init', 'changed']])), /changed/);
  assert.throws(() => assertExpansion(old, new Map()), /disappeared/);
});

test('smoke failure returns the release error even after the previous app has recovered', async () => {
  const events = [];
  await assert.rejects(
    replaceApplication(
      async () => {
        events.push('candidate');
        throw new Error('smoke failed');
      },
      async () => {
        events.push('previous');
      },
    ),
    /smoke failed/,
  );
  assert.deepEqual(events, ['candidate', 'previous']);
});
