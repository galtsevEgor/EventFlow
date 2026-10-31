import { offlineSyncResultSchema, type OfflineSync } from '@eventflow/event-contracts';
import { openCredential } from './crypto';
import { type GateDatabase, scanAad } from './database';
export class GateSyncError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function synchronize(
  db: GateDatabase,
  actorSubject: string,
  eventId: string,
  send: (body: OfflineSync) => Promise<unknown>,
  lock:
    ((name: string, run: () => Promise<void>) => Promise<void>) | undefined = typeof navigator !==
    'undefined' && navigator.locks
    ? async (name, run) => {
        await navigator.locks.request(name, run);
      }
    : undefined,
) {
  if (!lock) throw new Error('Для синхронизации нужен браузер с Web Locks.');
  await lock('eventflow-gate-sync:' + actorSubject, async () => {
    if ((await db.activeActor()) !== actorSubject)
      throw new Error('Войдите в исходный аккаунт для синхронизации.');
    const pending = await db.scans
      .where('[actorSubject+eventId]')
      .equals([actorSubject, eventId])
      .filter((s) => s.state === 'PENDING')
      .sortBy('capturedAt');
    const key = await db.vault(actorSubject);
    for (const sessionId of [...new Set(pending.map((s) => s.sessionId))]) {
      const sessionRows = pending.filter((s) => s.sessionId === sessionId);
      for (let offset = 0; offset < sessionRows.length; offset += 50) {
        const rows = sessionRows.slice(offset, offset + 50),
          first = rows[0];
        if (!first) continue;
        const operations = await Promise.all(
          rows.map(async (row) => {
            if (!row.sealed) throw new Error('Сохранённая проверка повреждена.');
            return {
              requestId: row.requestId,
              credential: await openCredential(key, row.sealed, scanAad(row)),
              capturedAt: row.capturedAt,
            };
          }),
        );
        if ((await db.activeActor()) !== actorSubject)
          throw new Error('Аккаунт изменился. Синхронизация остановлена.');
        let data: unknown;
        try {
          data = await send({ sessionId, deviceId: first.deviceId, operations });
        } catch (error) {
          if (error instanceof GateSyncError && error.status === 403)
            await db.block(actorSubject, eventId);
          throw error;
        }
        const result = offlineSyncResultSchema.parse(data),
          expected = new Set(rows.map((r) => r.requestId));
        if (
          result.results.length !== rows.length ||
          new Set(result.results.map((r) => r.requestId)).size !== rows.length ||
          result.results.some((r) => !expected.has(r.requestId))
        )
          throw new Error('Ответ синхронизации неполный. Повторите отправку.');
        await db.settle(actorSubject, sessionId, result.results);
      }
    }
  });
}
