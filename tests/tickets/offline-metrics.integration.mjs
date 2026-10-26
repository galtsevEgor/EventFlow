import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { OfflineMetrics } from '../../services/tickets/dist/offline-metrics.js';
import { OfflineCheckIn } from '../../services/tickets/dist/offline-check-in.js';
import { CheckInTicket } from '../../services/tickets/dist/check-in.js';
import { QrCredentials } from '../../services/tickets/dist/qr-credentials.js';
import { ticketsDatabase } from '../helpers/tickets-database.mjs';

test('offline gauges count durable sessions and unique offline outcomes with bounded private labels', async () => {
  const fixture = await ticketsDatabase();
  try {
    const { db } = fixture;
    const metrics = new OfflineMetrics(db);
    metrics.onModuleInit();
    const empty = await metrics.collect();
    assert.equal(empty.length, 8);
    assert.ok(empty.every((row) => row.value === 0));
    const scope = { deviceId: randomUUID(), eventId: randomUUID(), organizationId: randomUUID() };
    const actor = 'private-actor-subject';
    const qr = new QrCredentials(`v1:${randomBytes(32).toString('hex')}`);
    const id = randomUUID();
    const ticket = await db.ticket.create({
      data: {
        id,
        orderId: randomUUID(),
        saleId: scope.eventId,
        organizationId: scope.organizationId,
        buyerSubject: 'private-buyer',
        seatId: 'a1',
        row: 1,
        number: 1,
        categoryName: 'Standard',
        ...qr.issue(id),
      },
    });
    const window = {
      admissionStartsAt: new Date(Date.now() - 60000).toISOString(),
      admissionEndsAt: new Date(Date.now() + 3600000).toISOString(),
    };
    const offline = new OfflineCheckIn(db, randomBytes(32).toString('hex'));
    const manifest = JSON.parse((await offline.prepare(actor, scope, window)).payload);
    const operation = {
      requestId: randomUUID(),
      credential: qr.reveal(ticket),
      capturedAt: new Date().toISOString(),
    };
    const input = {
      sessionId: manifest.sessionId,
      deviceId: scope.deviceId,
      operations: [operation],
    };
    await offline.sync(actor, input, window);
    await offline.sync(actor, input, window);
    await new CheckInTicket(db).run(
      actor,
      { ...operation, ...scope, requestId: randomUUID() },
      window,
    );
    const populated = await metrics.collect();
    assert.equal(populated.find((row) => row.name === 'eventflow_offline_sessions').value, 1);
    assert.equal(populated.find((row) => row.attributes.state === 'ADMITTED').value, 1);
    assert.equal(populated.find((row) => row.attributes.state === 'ALREADY_USED').value, 0);
    await db.offlineSession.update({
      where: { id: manifest.sessionId },
      data: { issuedAt: new Date(Date.now() - 60000), expiresAt: new Date(Date.now() - 1000) },
    });
    await offline.sync(
      actor,
      { ...input, operations: [{ ...operation, requestId: randomUUID() }] },
      window,
    );
    await offline.sync(actor, input, window);
    const expired = await metrics.collect();
    assert.equal(expired.find((row) => row.name === 'eventflow_offline_sessions').value, 0);
    assert.equal(expired.find((row) => row.attributes.state === 'WINDOW_CLOSED').value, 1);
    assert.equal(
      expired
        .filter((row) => row.name === 'eventflow_offline_scans')
        .reduce((sum, row) => sum + row.value, 0),
      2,
    );
    assert.deepEqual(
      new Set(expired.flatMap((row) => Object.keys(row.attributes))),
      new Set(['state']),
    );
    assert.deepEqual(
      new Set(expired.map((row) => row.attributes.state)),
      new Set([
        'ACTIVE',
        'ADMITTED',
        'ALREADY_USED',
        'WRONG_EVENT',
        'INVALID_TICKET',
        'WINDOW_CLOSED',
        'REFUND_PENDING',
        'REFUNDED',
      ]),
    );
    const serialized = JSON.stringify(expired);
    for (const privateValue of [
      actor,
      scope.deviceId,
      scope.eventId,
      scope.organizationId,
      ticket.id,
      ticket.orderId,
      manifest.sessionId,
      operation.requestId,
      operation.credential,
    ])
      assert.ok(!serialized.includes(privateValue));
    metrics.onModuleDestroy();
  } finally {
    await fixture.close();
  }
});
