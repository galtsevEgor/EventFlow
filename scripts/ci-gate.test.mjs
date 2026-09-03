import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSuccessfulJobs } from './ci-gate.mjs';

test('gate accepts only success from every required job', () => {
  assert.doesNotThrow(() =>
    assertSuccessfulJobs({ quality: { result: 'success' }, integration: { result: 'success' } }),
  );
});
for (const name of ['quality', 'integration']) {
  test(`gate rejects failed, skipped, cancelled or missing ${name}`, () => {
    for (const result of ['failure', 'skipped', 'cancelled', undefined]) {
      const needs = { quality: { result: 'success' }, integration: { result: 'success' } };
      needs[name] = { result };
      assert.throws(() => assertSuccessfulJobs(needs), new RegExp(name));
    }
    assert.throws(() => assertSuccessfulJobs({}), /missing/);
  });
}
