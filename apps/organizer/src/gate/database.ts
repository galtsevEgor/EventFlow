import { Dexie, type EntityTable } from 'dexie';
import {
  type OfflineBundle,
  type OfflineManifest,
  type OfflineResult,
} from '@eventflow/event-contracts';
import { createVaultKey, hash, sealCredential, type SealedCredential } from './crypto';
export type Snapshot = {
  id: string;
  actorSubject: string;
  organizationId: string;
  eventId: string;
  deviceId: string;
  bundle: OfflineBundle;
  manifest: OfflineManifest;
  keyId: string;
  publicKey: CryptoKey;
  blocked: boolean;
};
export type Scan = {
  requestId: string;
  actorSubject: string;
  eventId: string;
  sessionId: string;
  deviceId: string;
  credentialHash: string;
  capturedAt: string;
  state: 'PENDING' | 'FINAL';
  sealed: SealedCredential | null;
  result: OfflineResult | null;
};
type Meta = { id: string; value: string };
type Vault = { id: string; key: CryptoKey };
export class GateDatabase extends Dexie {
  meta!: EntityTable<Meta, 'id'>;
  vaults!: EntityTable<Vault, 'id'>;
  snapshots!: EntityTable<Snapshot, 'id'>;
  scans!: EntityTable<Scan, 'requestId'>;
  constructor(name = 'eventflow-gate') {
    super(name);
    this.version(1).stores({
      meta: '&id',
      vaults: '&id',
      snapshots: '&id,[actorSubject+eventId]',
      scans:
        '&requestId,[actorSubject+eventId],[actorSubject+state],[actorSubject+eventId+credentialHash],capturedAt',
    });
    this.version(2).stores({
      scans:
        '&requestId,[actorSubject+eventId],[actorSubject+state],[actorSubject+eventId+credentialHash],capturedAt,[actorSubject+capturedAt]',
    });
  }
  async device() {
    return this.transaction('rw', this.meta, async () => {
      const row = await this.meta.get('device');
      if (row) return row.value;
      const value = crypto.randomUUID();
      await this.meta.add({ id: 'device', value });
      return value;
    });
  }
  async identity(actorSubject: string | null) {
    if (actorSubject) await this.meta.put({ id: 'actor', value: actorSubject });
    else await this.meta.delete('actor');
  }
  async activeActor() {
    return (await this.meta.get('actor'))?.value ?? null;
  }
  async vault(actorSubject: string) {
    const existing = await this.vaults.get(actorSubject);
    if (existing) return existing.key;
    const key = await createVaultKey();
    return this.transaction('rw', this.vaults, async () => {
      const current = await this.vaults.get(actorSubject);
      if (current) return current.key;
      await this.vaults.add({ id: actorSubject, key });
      return key;
    });
  }
  async saveSnapshot(snapshot: Snapshot) {
    return this.transaction('rw', this.meta, this.snapshots, async () => {
      if ((await this.activeActor()) !== snapshot.actorSubject)
        throw new Error('Аккаунт изменился. Повторите вход.');
      await this.snapshots.put(snapshot);
    });
  }
  async latest(actorSubject: string, eventId: string) {
    const rows = await this.snapshots
      .where('[actorSubject+eventId]')
      .equals([actorSubject, eventId])
      .toArray();
    return rows.sort((a, b) => b.manifest.issuedAt.localeCompare(a.manifest.issuedAt))[0];
  }
  async capture(snapshot: Snapshot, credential: string, now: number) {
    if (!/^[A-Za-z0-9_-]{32}$/.test(credential)) throw new Error('Проверьте формат кода билета.');
    const credentialHash = await hash(credential),
      key = await this.vault(snapshot.actorSubject),
      requestId = crypto.randomUUID();
    const capturedAt = new Date(now).toISOString();
    const sealed = await sealCredential(
      key,
      credential,
      scanAad({
        requestId,
        actorSubject: snapshot.actorSubject,
        sessionId: snapshot.id,
        credentialHash,
        capturedAt,
      }),
    );
    const row: Scan = {
      requestId,
      actorSubject: snapshot.actorSubject,
      eventId: snapshot.eventId,
      sessionId: snapshot.id,
      deviceId: snapshot.deviceId,
      credentialHash,
      capturedAt,
      sealed,
      state: 'PENDING',
      result: null,
    };
    return this.transaction('rw', this.meta, this.snapshots, this.scans, async () => {
      if ((await this.activeActor()) !== row.actorSubject)
        throw new Error('Аккаунт изменился. Сканирование не сохранено.');
      const current = await this.snapshots.get(snapshot.id);
      if (!current || current.blocked)
        throw new Error('Подготовка недоступна. Проверьте права онлайн.');
      if (
        now < Date.parse(current.manifest.issuedAt) ||
        now >= Date.parse(current.manifest.expiresAt)
      )
        throw new Error('Снимок устарел. Подготовьте мероприятие онлайн.');
      if (
        now < Date.parse(current.manifest.admissionStartsAt) ||
        now >= Date.parse(current.manifest.admissionEndsAt)
      )
        throw new Error('Окно допуска сейчас закрыто.');
      if (!current.manifest.hashes.includes(credentialHash))
        throw new Error('Билет отсутствует в подготовленном снимке.');
      const previous = await this.scans
        .where('[actorSubject+eventId+credentialHash]')
        .equals([row.actorSubject, row.eventId, credentialHash])
        .toArray();
      if (
        previous.some(
          (s) =>
            s.state === 'PENDING' ||
            s.result?.result === 'ADMITTED' ||
            s.result?.result === 'ALREADY_USED',
        )
      )
        throw new Error('Этот билет уже проверен на этом устройстве.');
      if (
        (await this.scans
          .where('[actorSubject+state]')
          .equals([row.actorSubject, 'PENDING'])
          .count()) >= 5000
      )
        throw new Error('Очередь заполнена. Синхронизируйте сохранённые проверки.');
      await this.scans.add(row);
      return row;
    });
  }
  async settle(actorSubject: string, sessionId: string, results: OfflineResult[]) {
    return this.transaction('rw', this.scans, async () => {
      for (const result of results) {
        const current = await this.scans.get(result.requestId);
        if (!current || current.actorSubject !== actorSubject || current.sessionId !== sessionId)
          throw new Error('Ответ синхронизации не соответствует очереди.');
        await this.scans.update(result.requestId, { state: 'FINAL', sealed: null, result });
      }
    });
  }
  async block(actorSubject: string, eventId: string) {
    await this.snapshots
      .where('[actorSubject+eventId]')
      .equals([actorSubject, eventId])
      .modify({ blocked: true });
  }
  async discard(actorSubject: string, eventId: string) {
    return this.transaction('rw', this.meta, this.scans, this.snapshots, async () => {
      if ((await this.activeActor()) !== actorSubject)
        throw new Error('Аккаунт изменился. Данные не удалены.');
      await this.scans.where('[actorSubject+eventId]').equals([actorSubject, eventId]).delete();
      await this.snapshots.where('[actorSubject+eventId]').equals([actorSubject, eventId]).delete();
    });
  }
}
export function scanAad(
  scan: Pick<Scan, 'actorSubject' | 'sessionId' | 'requestId' | 'credentialHash' | 'capturedAt'>,
) {
  return JSON.stringify([
    scan.actorSubject,
    scan.sessionId,
    scan.requestId,
    scan.credentialHash,
    scan.capturedAt,
  ]);
}
export const gateDatabase = new GateDatabase();
