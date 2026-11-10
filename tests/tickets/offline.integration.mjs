import assert from 'node:assert/strict';
import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import test from 'node:test';
import { OfflineCheckIn } from '../../services/tickets/dist/offline-check-in.js';
import { OfflineCheckInController } from '../../services/tickets/dist/offline-check-in.controller.js';
import { CheckInTicket } from '../../services/tickets/dist/check-in.js';
import { QrCredentials } from '../../services/tickets/dist/qr-credentials.js';
import { ticketsDatabase } from '../helpers/tickets-database.mjs';
const status = (code) => (error) => error.getStatus() === code;
const open = () => ({
  admissionStartsAt: new Date(Date.now() - 60000).toISOString(),
  admissionEndsAt: new Date(Date.now() + 3600000).toISOString(),
});

test('signed snapshots filter private, used and refund-held tickets; scope and time limits fail closed', async () => {
  const fixture = await ticketsDatabase();
  try {
    const { db } = fixture;
    const service = new OfflineCheckIn(db, randomBytes(32).toString('hex'));
    const qr = new QrCredentials(`v1:${randomBytes(32).toString('hex')}`);
    const scope = { organizationId: randomUUID(), eventId: randomUUID(), deviceId: randomUUID() };
    const create = async (options = {}) => {
      const id = randomUUID();
      return db.ticket.create({
        data: {
          id,
          orderId: randomUUID(),
          saleId: scope.eventId,
          organizationId: scope.organizationId,
          buyerSubject: 'private-buyer',
          seatId: id,
          row: 1,
          number: 1,
          categoryName: 'private-category',
          ...qr.issue(id),
          ...options,
        },
      });
    };
    // seatId has a deliberately short value in the real schema.
    const ticket = await create({ seatId: 'a1' });
    await create({ seatId: 'a2', usedAt: new Date() });
    for (const state of ['LOCKED', 'REVOKED']) {
      const record = await create({ seatId: state });
      await db.refundGate.create({
        data: {
          orderId: record.orderId,
          operationId: randomUUID(),
          saleId: scope.eventId,
          organizationId: scope.organizationId,
          state,
        },
      });
    }
    await create({ seatId: 'other', saleId: randomUUID() });
    const bundle = await service.prepare('staff', scope, open());
    const manifest = JSON.parse(bundle.payload);
    const key = service.keys().keys[0];
    assert.equal(bundle.keyId, key.id);
    assert.ok(
      verify(
        null,
        Buffer.from(bundle.payload),
        createPublicKey({ key: key.jwk, format: 'jwk' }),
        Buffer.from(bundle.signature, 'base64url'),
      ),
    );
    assert.ok(
      !verify(
        null,
        Buffer.from(bundle.payload + ' '),
        createPublicKey({ key: key.jwk, format: 'jwk' }),
        Buffer.from(bundle.signature, 'base64url'),
      ),
    );
    assert.deepEqual(manifest.hashes, [ticket.qrHash]);
    assert.equal(+new Date(manifest.expiresAt) - +new Date(manifest.issuedAt), 1800000);
    for (const secret of [qr.reveal(ticket), 'private-buyer', 'private-category'])
      assert.ok(!bundle.payload.includes(secret));
    await assert.rejects(
      () => service.session('other', manifest.sessionId, scope.deviceId),
      status(403),
    );
    await assert.rejects(
      () => service.session('staff', manifest.sessionId, randomUUID()),
      status(403),
    );
    await assert.rejects(
      () =>
        service.prepare('staff', scope, {
          ...open(),
          admissionStartsAt: new Date(Date.now() + 86460000).toISOString(),
        }),
      status(409),
    );
    await assert.rejects(
      () =>
        service.prepare('staff', scope, {
          ...open(),
          admissionEndsAt: new Date(Date.now() - 1000).toISOString(),
        }),
      status(409),
    );
    assert.throws(() => new OfflineCheckIn(db).keys(), status(503));
    await assert.rejects(() => new OfflineCheckIn(db).prepare('staff', scope, open()), status(503));
    const capped = JSON.parse(
      (
        await service.prepare('staff', scope, {
          ...open(),
          admissionEndsAt: new Date(Date.now() + 10000).toISOString(),
        })
      ).payload,
    );
    assert.ok(+new Date(capped.expiresAt) - +new Date(capped.issuedAt) <= 10000);
  } finally {
    await fixture.close();
  }
});

test('sync persists partial progress, replays lost replies after expiry, and fences mutations and concurrent scanners', async () => {
  const fixture = await ticketsDatabase();
  try {
    const { db } = fixture;
    const service = new OfflineCheckIn(db, randomBytes(32).toString('hex'));
    const qr = new QrCredentials(`v1:${randomBytes(32).toString('hex')}`);
    const scope = { organizationId: randomUUID(), eventId: randomUUID(), deviceId: randomUUID() };
    const create = async () => {
      const id = randomUUID();
      return db.ticket.create({
        data: {
          id,
          orderId: randomUUID(),
          saleId: scope.eventId,
          organizationId: scope.organizationId,
          buyerSubject: 'buyer',
          seatId: 'a1',
          row: 1,
          number: 1,
          categoryName: 'Standard',
          ...qr.issue(id),
        },
      });
    };
    const ticket = await create();
    const window = open();
    const manifest = JSON.parse((await service.prepare('staff', scope, window)).payload);
    const base = { sessionId: manifest.sessionId, deviceId: scope.deviceId };
    const closed = { ...window, admissionStartsAt: window.admissionEndsAt };
    const operation = {
      requestId: randomUUID(),
      credential: qr.reveal(ticket),
      capturedAt: new Date(Date.parse(window.admissionEndsAt) + 60000).toISOString(),
    };
    const first = await service.sync('staff', { ...base, operations: [operation] }, window);
    assert.equal(first.results[0].result, 'ADMITTED');
    assert.equal(first.results[0].reason, null);
    const audit = await db.checkIn.findUniqueOrThrow({ where: { requestId: operation.requestId } });
    assert.equal(audit.capturedAt.toISOString(), operation.capturedAt);
    assert.equal(audit.checkedAt.toISOString(), first.results[0].admittedAt);
    assert.ok(audit.checkedAt < audit.capturedAt);
    const lateTicket = await create();
    const lateOperation = { ...operation, credential: qr.reveal(lateTicket) };
    const absent = await service.sync(
      'staff',
      { ...base, operations: [{ ...lateOperation, requestId: randomUUID() }] },
      closed,
    );
    assert.deepEqual(
      [absent.results[0].result, absent.results[0].reason],
      ['INVALID_TICKET', 'NOT_IN_SNAPSHOT'],
    );
    await db.offlineSession.update({
      where: { id: manifest.sessionId },
      data: { issuedAt: new Date(Date.now() - 60000), expiresAt: new Date(Date.now() - 1000) },
    });
    assert.deepEqual(
      await service.sync('staff', { ...base, operations: [operation] }, window),
      first,
    );
    const expired = await service.sync(
      'staff',
      { ...base, operations: [{ ...lateOperation, requestId: randomUUID() }] },
      closed,
    );
    assert.deepEqual(
      [expired.results[0].result, expired.results[0].reason],
      ['WINDOW_CLOSED', 'SNAPSHOT_EXPIRED'],
    );
    await assert.rejects(
      () =>
        service.sync(
          'staff',
          {
            ...base,
            operations: [{ ...operation, capturedAt: new Date(Date.now() - 1000).toISOString() }],
          },
          window,
        ),
      status(409),
    );
    await assert.rejects(
      () => new CheckInTicket(db).run('staff', { ...operation, ...scope }, window),
      status(409),
    );
    // A later conflicting operation cannot roll back an earlier committed result.
    const partial = { ...operation, requestId: randomUUID() };
    await assert.rejects(
      () =>
        service.sync(
          'staff',
          { ...base, operations: [partial, { ...operation, credential: qr.reveal(lateTicket) }] },
          window,
        ),
      status(409),
    );
    assert.ok(await db.checkIn.findUnique({ where: { requestId: partial.requestId } }));
    const concurrentTicket = await create();
    const next = JSON.parse((await service.prepare('staff', scope, window)).payload);
    const scans = await Promise.all(
      [1, 2].map(() =>
        service.sync(
          'staff',
          {
            sessionId: next.sessionId,
            deviceId: scope.deviceId,
            operations: [
              { ...operation, requestId: randomUUID(), credential: qr.reveal(concurrentTicket) },
            ],
          },
          window,
        ),
      ),
    );
    assert.deepEqual(scans.map((r) => r.results[0].result).sort(), ['ADMITTED', 'ALREADY_USED']);
    const refunded = await create();
    const refundSession = JSON.parse((await service.prepare('staff', scope, window)).payload);
    await db.refundGate.create({
      data: {
        orderId: refunded.orderId,
        operationId: randomUUID(),
        saleId: scope.eventId,
        organizationId: scope.organizationId,
        state: 'REVOKED',
      },
    });
    const revoked = await service.sync(
      'staff',
      {
        sessionId: refundSession.sessionId,
        deviceId: scope.deviceId,
        operations: [{ ...operation, requestId: randomUUID(), credential: qr.reveal(refunded) }],
      },
      window,
    );
    assert.equal(revoked.results[0].result, 'REFUNDED');
    assert.ok(!JSON.stringify(await db.checkIn.findMany()).includes(operation.credential));
  } finally {
    await fixture.close();
  }
});

test('controller checks authentication, verified email and current policy before any sync effect', async () => {
  let effects = 0;
  const offline = {
    keys() {
      effects++;
    },
    session: async () => ({ organizationId: randomUUID(), eventId: randomUUID() }),
    sync() {
      effects++;
    },
  };
  const denied = {
    window: async () => {
      throw Object.assign(new Error('forbidden'), { getStatus: () => 403 });
    },
  };
  const input = {
    sessionId: randomUUID(),
    deviceId: randomUUID(),
    operations: [
      {
        requestId: randomUUID(),
        credential: randomBytes(24).toString('base64url'),
        capturedAt: new Date().toISOString(),
      },
    ],
  };
  const controller = new OfflineCheckInController(
    { user: async () => ({ subject: 'staff', emailVerified: true }) },
    denied,
    offline,
  );
  await assert.rejects(() => controller.sync('bearer', input), status(403));
  const unverified = new OfflineCheckInController(
    { user: async () => ({ subject: 'staff', emailVerified: false }) },
    denied,
    offline,
  );
  await assert.rejects(() => unverified.keys('bearer'), status(403));
  const unauthenticated = new OfflineCheckInController(
    {
      user: async () => {
        throw Object.assign(new Error('unauthorized'), { getStatus: () => 401 });
      },
    },
    denied,
    offline,
  );
  await assert.rejects(() => unauthenticated.sync(undefined, input), status(401));
  assert.equal(effects, 0);
});

test('decision clock is read after the ticket lock, and oversized snapshots are rejected without session creation', async () => {
  const fixture = await ticketsDatabase();
  try {
    const { db } = fixture;
    const service = new OfflineCheckIn(db, randomBytes(32).toString('hex'));
    const qr = new QrCredentials(`v1:${randomBytes(32).toString('hex')}`);
    const scope = { organizationId: randomUUID(), eventId: randomUUID(), deviceId: randomUUID() };
    const id = randomUUID();
    const ticket = await db.ticket.create({
      data: {
        id,
        orderId: randomUUID(),
        saleId: scope.eventId,
        organizationId: scope.organizationId,
        buyerSubject: 'buyer',
        seatId: 'a1',
        row: 1,
        number: 1,
        categoryName: 'Standard',
        ...qr.issue(id),
      },
    });
    const window = open();
    const manifest = JSON.parse((await service.prepare('staff', scope, window)).payload);
    await db.offlineSession.update({
      where: { id: manifest.sessionId },
      data: { expiresAt: new Date(Date.now() + 300) },
    });
    let release;
    let locked;
    const ready = new Promise((resolve) => {
      locked = resolve;
    });
    const held = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Ticket" WHERE id = ${id}::uuid FOR UPDATE`;
      locked();
      await new Promise((resolve) => {
        release = resolve;
      });
    });
    await ready;
    const pending = service.sync(
      'staff',
      {
        sessionId: manifest.sessionId,
        deviceId: scope.deviceId,
        operations: [
          {
            requestId: randomUUID(),
            credential: qr.reveal(ticket),
            capturedAt: new Date().toISOString(),
          },
        ],
      },
      window,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    release();
    await held;
    assert.equal((await pending).results[0].reason, 'SNAPSHOT_EXPIRED');
    assert.equal((await db.ticket.findUnique({ where: { id } })).usedAt, null);
    const largeEvent = randomUUID();
    await db.$executeRaw`
      INSERT INTO "Ticket" (id,"orderId","seatId","saleId","organizationId","buyerSubject",row,number,"categoryName","qrHash","qrKeyId","qrEncrypted")
      SELECT gen_random_uuid(),gen_random_uuid(),'a1',${largeEvent}::uuid,${scope.organizationId}::uuid,'buyer',1,1,'Standard',
        lpad(n::text,64,'0'),'v1',decode('00','hex') FROM generate_series(1,10001) n`;
    const before = await db.offlineSession.count();
    await assert.rejects(
      () => service.prepare('staff', { ...scope, eventId: largeEvent }, window),
      status(409),
    );
    assert.equal(await db.offlineSession.count(), before);
  } finally {
    await fixture.close();
  }
});
