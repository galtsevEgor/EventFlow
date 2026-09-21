import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { paymentsDatabase } from '../helpers/payments-database.mjs';
import { message } from '../../packages/event-contracts/dist/index.js';

test('history replay preserves original events and uses dedicated routes with stable fact identities', async () => {
  const fixture = await paymentsDatabase();
  try {
    const events = ['PaymentSucceeded.v1', 'RefundSucceeded.v1', 'RefundReviewRequired.v1'].map(
      (type) => message('payments', type, randomUUID(), 1, {}),
    );
    await fixture.db.outbox.createMany({
      data: events.map((envelope) => ({
        id: envelope.eventId,
        envelope,
        sentAt: new Date(),
      })),
    });
    await fixture.db.$executeRawUnsafe(
      readFileSync(
        'services/payments/prisma/migrations/202611050001_statistics_replay/migration.sql',
        'utf8',
      ),
    );
    for (const [index, event] of events.entries()) {
      const row = await fixture.db.outbox.findUnique({ where: { id: event.eventId } });
      assert.deepEqual(row.envelope, event);
      assert.notEqual(row.sentAt, null);
      const copies = await fixture.db.outbox.findMany({
        where: { envelope: { path: ['causationId'], equals: event.eventId } },
      });
      assert.equal(copies.length, index < 2 ? 1 : 0);
      if (index < 2) {
        assert.equal(copies[0].sentAt, null);
        assert.equal(copies[0].envelope.occurredAt, event.occurredAt);
        assert.deepEqual(copies[0].envelope.data, event.data);
        assert.match(copies[0].envelope.eventType, /StatisticsReplayed/);
        assert.notEqual(copies[0].envelope.eventId, event.eventId);
      }
    }
    assert.equal(await fixture.db.outbox.count(), 5);
  } finally {
    await fixture.close();
  }
});
