import 'fake-indexeddb/auto';
import { Dexie } from 'dexie';
import { afterEach, describe, it, expect } from 'vitest';
import { GateDatabase, type Snapshot } from '../src/gate/database';
import { synchronize, GateSyncError } from '../src/gate/sync';
import { hash, createVaultKey } from '../src/gate/crypto';
const databases: GateDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete();
});
async function fixture() {
  const db = new GateDatabase('gate-test-' + crypto.randomUUID());
  databases.push(db);
  const now = Date.now(),
    actorSubject = 'operator',
    eventId = crypto.randomUUID(),
    id = crypto.randomUUID(),
    credential = 'a'.repeat(32);
  const snapshot: Snapshot = {
    id,
    actorSubject,
    eventId,
    organizationId: crypto.randomUUID(),
    deviceId: await db.device(),
    bundle: { payload: '', signature: '', keyId: '' },
    keyId: '',
    publicKey: await createVaultKey(),
    blocked: false,
    manifest: {
      version: 1,
      sessionId: id,
      actorSubject,
      eventId,
      organizationId: '',
      deviceId: '',
      issuedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(),
      admissionStartsAt: new Date(now - 60000).toISOString(),
      admissionEndsAt: new Date(now + 3600000).toISOString(),
      hashes: [await hash(credential)],
    },
  };
  await db.identity(actorSubject);
  await db.saveSnapshot(snapshot);
  return { db, snapshot, now, credential };
}
const lock = async (_name: string, run: () => Promise<void>) => run();
describe('durable gate scan queue', () => {
  it('upgrades an existing database without losing pending ciphertext, keys or device identity', async () => {
    const f = await fixture(),
      row = await f.db.capture(f.snapshot, f.credential, f.now);
    const name = f.db.name,
      vault = await f.db.vaults.get('operator');
    await f.db.delete();
    const legacy = new Dexie(name);
    legacy.version(1).stores({
      meta: '&id',
      vaults: '&id',
      snapshots: '&id,[actorSubject+eventId]',
      scans:
        '&requestId,[actorSubject+eventId],[actorSubject+state],[actorSubject+eventId+credentialHash],capturedAt',
    });
    try {
      await legacy.table('meta').bulkPut([
        { id: 'actor', value: 'operator' },
        { id: 'device', value: f.snapshot.deviceId },
      ]);
      await legacy.table('vaults').put(vault);
      await legacy.table('snapshots').put(f.snapshot);
      await legacy.table('scans').put(row);
    } finally {
      legacy.close();
    }
    const upgraded = new GateDatabase(name);
    databases.push(upgraded);
    await upgraded.open();
    expect(upgraded.verno).toBe(2);
    expect(await upgraded.device()).toBe(f.snapshot.deviceId);
    expect(await upgraded.activeActor()).toBe('operator');
    expect(await upgraded.scans.get(row.requestId)).toEqual(row);
    expect((await upgraded.vault('operator')).extractable).toBe(false);
    let uploads = 0;
    await synchronize(
      upgraded,
      'operator',
      f.snapshot.eventId,
      async (body) => {
        expect(body.operations[0]!.credential).toBe(f.credential);
        uploads++;
        return {
          results: [
            {
              requestId: row.requestId,
              result: 'ADMITTED',
              admittedAt: new Date().toISOString(),
              reason: null,
            },
          ],
        };
      },
      lock,
    );
    expect(uploads).toBe(1);
    expect((await upgraded.scans.get(row.requestId))!.sealed).toBeNull();
  });
  it('atomically deduplicates concurrent captures and survives reopening with encrypted credentials', async () => {
    const f = await fixture(),
      both = await Promise.allSettled([
        f.db.capture(f.snapshot, f.credential, f.now),
        f.db.capture(f.snapshot, f.credential, f.now),
      ]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    f.db.close();
    await f.db.open();
    const rows = await f.db.scans.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('PENDING');
    expect(JSON.stringify(rows)).not.toContain(f.credential);
  });
  it('failed storage writes never indicate a saved scan', async () => {
    const f = await fixture();
    f.db.scans.hook('creating', () => {
      throw new DOMException('Disk full', 'QuotaExceededError');
    });
    await expect(f.db.capture(f.snapshot, f.credential, f.now)).rejects.toThrow('Disk full');
    expect(await f.db.scans.count()).toBe(0);
  });
  it('retries the same operation after lost ACK and destroys the credential only after final settlement', async () => {
    const f = await fixture(),
      row = await f.db.capture(f.snapshot, f.credential, f.now),
      seen: string[] = [];
    let lost = true;
    const send = async (body: Parameters<Parameters<typeof synchronize>[3]>[0]) => {
      seen.push(body.operations[0]!.requestId);
      if (lost) {
        lost = false;
        throw new Error('Lost ACK');
      }
      return {
        results: [
          {
            requestId: row.requestId,
            result: 'ADMITTED',
            admittedAt: new Date().toISOString(),
            reason: null,
          },
        ],
      };
    };
    await expect(synchronize(f.db, 'operator', f.snapshot.eventId, send, lock)).rejects.toThrow(
      'Lost ACK',
    );
    expect((await f.db.scans.get(row.requestId))!.sealed).not.toBeNull();
    await synchronize(f.db, 'operator', f.snapshot.eventId, send, lock);
    expect(seen).toEqual([row.requestId, row.requestId]);
    const final = await f.db.scans.get(row.requestId);
    expect(final!.state).toBe('FINAL');
    expect(final!.sealed).toBeNull();
  });
  it('account changes and revoked permissions block new work without discarding pending scans', async () => {
    const f = await fixture();
    await f.db.capture(f.snapshot, f.credential, f.now);
    await expect(
      synchronize(
        f.db,
        'operator',
        f.snapshot.eventId,
        async () => {
          throw new GateSyncError(403, 'Forbidden');
        },
        lock,
      ),
    ).rejects.toThrow('Forbidden');
    expect((await f.db.snapshots.get(f.snapshot.id))!.blocked).toBe(true);
    await f.db.identity('another');
    await expect(
      synchronize(f.db, 'operator', f.snapshot.eventId, async () => ({ results: [] }), lock),
    ).rejects.toThrow('исходный');
    expect(await f.db.scans.count()).toBe(1);
  });
  it('incomplete server responses keep the entire batch pending and snapshot refresh preserves older operations', async () => {
    const f = await fixture();
    await f.db.capture(f.snapshot, f.credential, f.now);
    await f.db.saveSnapshot({ ...f.snapshot, id: crypto.randomUUID() });
    await expect(
      synchronize(f.db, 'operator', f.snapshot.eventId, async () => ({ results: [] }), lock),
    ).rejects.toThrow('неполный');
    expect(await f.db.scans.count()).toBe(1);
    expect(await f.db.snapshots.count()).toBe(2);
  });
});
