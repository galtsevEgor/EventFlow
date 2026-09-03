import assert from 'node:assert/strict';
import test from 'node:test';
import { findBoundaryViolations } from './boundaries.mjs';

const packages = {
  '@eventflow/booking': 'services/booking',
  '@eventflow/event-contracts': 'packages/event-contracts',
};
test('rejects cross-service alias, relative imports and deep package implementation imports', () => {
  for (const statement of [
    "import x from '@eventflow/booking';",
    "export * from '../../booking/src/main';",
    "const x = import('@eventflow/booking');",
    "const x = require('@eventflow/booking');",
    "import x from '@eventflow/event-contracts/src/index';",
  ]) {
    assert.equal(
      findBoundaryViolations({ 'services/catalog/src/main.ts': statement }, packages).length,
      1,
    );
  }
});
test('permits public shared contracts and local implementation imports, ignoring comments', () => {
  const source =
    "import x from '@eventflow/event-contracts'; import y from './orders'; // import z from '@eventflow/booking';";
  assert.deepEqual(
    findBoundaryViolations({ 'services/catalog/src/main.ts': source }, packages),
    [],
  );
});
