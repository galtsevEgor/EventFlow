import { z } from 'zod';
import { encodedState } from '@eventflow/collaboration';

const prefix = 'eventflow:draft:';
const generation = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const cachedDraftSchema = z
  .strictObject({
    epoch: z.uuid(),
    state: encodedState,
    generation,
    acknowledged: generation,
    updatedAt: z.number(),
    inflight: z
      .strictObject({ id: z.uuid(), epoch: z.uuid(), state: encodedState, generation })
      .nullable(),
  })
  .refine(
    (value) =>
      value.acknowledged <= value.generation &&
      (!value.inflight ||
        (value.inflight.epoch === value.epoch && value.inflight.generation <= value.generation)),
  );
export type CachedDraft = z.infer<typeof cachedDraftSchema>;

export function cacheKey(subject: string, organizationId: string, eventId: string) {
  return prefix + encodeURIComponent(subject) + ':' + organizationId + ':' + eventId;
}
export function loadCopy(storage: Storage, key: string): CachedDraft | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  const parsed = cachedDraftSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error('Локальная копия повреждена. Не закрывайте редактор.');
  if (Date.now() - parsed.data.updatedAt > 86400000) {
    storage.removeItem(key);
    return null;
  }
  return parsed.data;
}
export function saveCopy(storage: Storage, key: string, value: CachedDraft) {
  const raw = JSON.stringify(cachedDraftSchema.parse(value));
  let count = 0,
    bytes = raw.length * 2;
  for (let i = 0; i < storage.length; i++) {
    const item = storage.key(i);
    if (item?.startsWith(prefix) && item !== key) {
      count++;
      bytes += (storage.getItem(item)?.length ?? 0) * 2;
    }
  }
  if (count >= 20 || bytes > 3 * 1024 * 1024) throw new Error('Нет места для локальной копии.');
  storage.setItem(key, raw);
}
export function clearDraftCopies(storage: Storage = sessionStorage) {
  const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i));
  for (const key of keys) if (key?.startsWith(prefix)) storage.removeItem(key);
}
export function hasPendingCopy(subject: string, organizationId: string, eventId: string) {
  try {
    const copy = loadCopy(sessionStorage, cacheKey(subject, organizationId, eventId));
    return !!copy && (copy.generation > copy.acknowledged || !!copy.inflight);
  } catch {
    return true;
  }
}
