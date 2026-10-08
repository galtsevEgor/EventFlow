import { z } from 'zod';
import type { Target } from './model';
const prefix = 'eventflow:ops:';
const schema = z.strictObject({
  key: z.uuid(),
  reason: z.string().min(8).max(240),
  version: z.string().regex(/^[a-f0-9]{64}$/),
  acknowledged: z.boolean(),
});
export type PendingRecovery = z.infer<typeof schema>;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
export function recoveryKey(actor: string, target: Target) {
  return prefix + [actor, target.service, target.kind, target.id].map(encodeURIComponent).join(':');
}
export function readPending(key: string, storage?: Store): PendingRecovery | null {
  try {
    const store = storage ?? sessionStorage,
      raw = store.getItem(key);
    if (!raw) return null;
    if (raw.length > 2048) {
      store.removeItem(key);
      return null;
    }
    const result = schema.safeParse(JSON.parse(raw));
    if (result.success) return result.data;
    store.removeItem(key);
  } catch {
    /* No request has been submitted by reading this cache. */
  }
  return null;
}
export function writePending(key: string, value: PendingRecovery, storage?: Store) {
  (storage ?? sessionStorage).setItem(key, JSON.stringify(schema.parse(value)));
}
export function removePending(key: string, storage?: Store) {
  try {
    (storage ?? sessionStorage).removeItem(key);
  } catch {
    /* The next session cannot use another actor's scoped key. */
  }
}
export function clearOperatorRequests(storage?: Store) {
  try {
    const store = storage ?? sessionStorage;
    for (let i = store.length - 1; i >= 0; i--) {
      const key = store.key(i);
      if (key?.startsWith(prefix)) store.removeItem(key);
    }
  } catch {
    /* Session termination still clears server access. */
  }
}
