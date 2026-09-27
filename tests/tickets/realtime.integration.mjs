import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ticketsDatabase } from '../helpers/tickets-database.mjs';
import { IssueTickets } from '../../services/tickets/dist/issue.js';
import { QrCredentials } from '../../services/tickets/dist/qr-credentials.js';
import { message, realtimeHintSchema } from '../../packages/event-contracts/dist/index.js';

test('ticket readiness invalidation commits with issuance, survives replay and contains no credential', async () => {
  const fixture = await ticketsDatabase();
  try {
    const orderId = randomUUID(),
      qr = new QrCredentials(process.env.TICKET_QR_KEYS);
    const event = message('booking', 'OrderConfirmed.v1', orderId, 2, {
      orderId,
      attemptId: randomUUID(),
      providerPaymentId: 'fake_verified',
      saleId: randomUUID(),
      organizationId: randomUUID(),
      buyerSubject: 'private-buyer',
      title: 'Live tickets',
      totalMinor: 2500,
      currency: 'EUR',
      confirmedAt: new Date().toISOString(),
      items: [{ seatId: 'r1-s1', row: 1, number: 1, categoryName: 'Standard', priceMinor: 2500 }],
    });
    const failing = new IssueTickets(
      {
        $transaction: (run) =>
          fixture.db.$transaction(async (tx) => {
            await run(tx);
            throw new Error('before commit');
          }),
      },
      qr,
    );
    await assert.rejects(failing.handle(event), /before commit/);
    assert.equal(await fixture.db.ticket.count(), 0);
    assert.equal(await fixture.db.outbox.count(), 0);
    const issue = new IssueTickets(fixture.db, qr);
    await issue.handle(event);
    await issue.handle({ ...event, eventId: randomUUID() });
    const outbox = await fixture.db.outbox.findMany();
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].envelope.eventType, 'RealtimeInvalidated.v1');
    assert.deepEqual(realtimeHintSchema.parse(outbox[0].envelope.data), {
      scope: 'order',
      id: orderId,
    });
  } finally {
    await fixture.close();
  }
});
