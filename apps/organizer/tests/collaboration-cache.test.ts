import { expect, it } from 'vitest';
import { Y } from '@eventflow/collaboration';
import {
  cacheKey,
  loadCopy,
  saveCopy,
  clearDraftCopies,
  type CachedDraft,
} from '../src/collaboration/cache';

function storage() {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
    clear: () => entries.clear(),
  };
}
const uuid = '11111111-1111-4111-8111-111111111111';
const record = (): CachedDraft => ({
  epoch: uuid,
  state: 'AAA=',
  generation: 2,
  acknowledged: 1,
  updatedAt: Date.now(),
  inflight: { id: uuid, epoch: uuid, state: 'AAA=', generation: 2 },
});

it('pending operations retain their exact id and payload across reload and remain isolated by actor', () => {
  const store = storage(),
    key = cacheKey('owner', uuid, uuid),
    value = record();
  saveCopy(store, key, value);
  expect(loadCopy(store, key)).toEqual(value);
  expect(loadCopy(store, cacheKey('staff', uuid, uuid))).toBeNull();
  store.setItem('unrelated', 'preserved');
  clearDraftCopies(store);
  expect(store.getItem(key)).toBeNull();
  expect(store.getItem('unrelated')).toBe('preserved');
});
it('corrupt and oversized copies are never silently overwritten or evicted to admit another draft', () => {
  const store = storage(),
    key = cacheKey('owner', uuid, uuid);
  store.setItem(key, '{invalid');
  expect(() => loadCopy(store, key)).toThrow();
  expect(store.getItem(key)).toBe('{invalid');
  store.clear();
  for (let i = 0; i < 20; i++) saveCopy(store, key + i, record());
  expect(() => saveCopy(store, key, record())).toThrow('Нет места');
  expect(store.length).toBe(20);
});
it('expired copies are removed and invalid acknowledgement generations cannot be persisted', () => {
  const store = storage(),
    key = cacheKey('owner', uuid, uuid);
  saveCopy(store, key, { ...record(), updatedAt: Date.now() - 86400001 });
  expect(loadCopy(store, key)).toBeNull();
  expect(() => saveCopy(store, key, { ...record(), acknowledged: 3 })).toThrow();
});
it('deletions require an explicit acknowledgement: an unchanged Yjs vector does not mean saved', () => {
  const doc = new Y.Doc();
  doc.getText('description').insert(0, 'Концерт');
  const before = Y.encodeStateVector(doc);
  const state = Y.encodeStateAsUpdate(doc);
  doc.getText('description').delete(0, 1);
  expect(Y.encodeStateVector(doc)).toEqual(before);
  expect(Y.encodeStateAsUpdate(doc)).not.toEqual(state);
  doc.destroy();
});
