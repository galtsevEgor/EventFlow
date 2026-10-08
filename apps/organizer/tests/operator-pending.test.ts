import { expect, it } from 'vitest';
import { readPending, writePending, clearOperatorRequests, recoveryKey } from '../src/ops/pending';
it('lost-response recovery preserves the exact command across reload and isolates actor caches', () => {
  const entries = new Map<string, string>(),
    storage = {
      get length() {
        return entries.size;
      },
      key(index: number) {
        return [...entries.keys()][index] ?? null;
      },
      getItem(key: string) {
        return entries.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        entries.set(key, value);
      },
      removeItem(key: string) {
        entries.delete(key);
      },
    };
  const target = {
      service: 'payments' as const,
      kind: 'refund' as const,
      id: '11111111-1111-4111-8111-111111111111',
    },
    key = recoveryKey('operator', target),
    command = {
      key: '22222222-2222-4222-8222-222222222222',
      reason: 'Provider restored',
      version: 'a'.repeat(64),
      acknowledged: false,
    };
  writePending(key, command, storage);
  expect(readPending(key, storage)).toEqual(command);
  expect(readPending(recoveryKey('another', target), storage)).toBeNull();
  storage.setItem(key, '{"key":"invalid"}');
  expect(readPending(key, storage)).toBeNull();
  expect(storage.getItem(key)).toBeNull();
  writePending(key, command, storage);
  storage.setItem('unrelated', 'preserved');
  clearOperatorRequests(storage);
  expect(storage.getItem(key)).toBeNull();
  expect(storage.getItem('unrelated')).toBe('preserved');
});
