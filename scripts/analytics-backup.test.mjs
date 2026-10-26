import test from 'node:test';
import assert from 'node:assert/strict';
import { backupDatabaseNames } from './release/backup.mjs';
test('old backups keep their original database set and new journals are explicitly restored', () => {
  const old = ['catalog', 'booking', 'payments', 'tickets', 'keycloak'];
  assert.deepEqual(backupDatabaseNames({ format: 1 }), old);
  assert.ok(
    backupDatabaseNames({ databases: [...old, 'analytics', 'waitlist'] }).includes('waitlist'),
  );
  assert.deepEqual(backupDatabaseNames({ databases: [...old, 'analytics'] }), [
    'catalog',
    'booking',
    'payments',
    'tickets',
    'analytics',
    'keycloak',
  ]);
  for (const databases of [
    ['catalog'],
    [...old, 'other'],
    [...old, 'analytics', 'analytics'],
    null,
    'analytics',
  ])
    assert.throws(() => backupDatabaseNames({ databases }), /Invalid backup/);
});
