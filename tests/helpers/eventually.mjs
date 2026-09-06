import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
export async function eventually(read, accept, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await delay(100);
  }
  assert.fail('Expected state was not reached before the deadline');
}
