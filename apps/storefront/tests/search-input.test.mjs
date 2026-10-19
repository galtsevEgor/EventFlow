import assert from 'node:assert/strict';
import test from 'node:test';
import { priceMinor } from '../app/search-api.ts';
test('search prices use exact decimal cents and reject precision loss or ambiguous values', () => {
  for (const [value, expected] of [
    ['0', 0],
    ['12.34', 1234],
    ['12,3', 1230],
    ['0.29', 29],
    ['1000000.00', 100000000],
    ['', undefined],
    [undefined, undefined],
  ])
    assert.equal(priceMinor(value), expected);
  for (const value of ['1e2', '-1', '1.234', '1000000.01', 'NaN', ['1', '2'], '12 eur'])
    assert.throws(() => priceMinor(value));
});
