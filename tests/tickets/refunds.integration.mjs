import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { message } from '../../packages/event-contracts/dist/index.js';
import { TicketRefunds } from '../../services/tickets/dist/refunds.js';
import { IssueTickets } from '../../services/tickets/dist/issue.js';
import { CheckInTicket } from '../../services/tickets/dist/check-in.js';
import { QrCredentials } from '../../services/tickets/dist/qr-credentials.js';
import { ticketsDatabase } from '../helpers/tickets-database.mjs';

function flow(db) {
  const orderId = randomUUID(),
    saleId = randomUUID(),
    organizationId = randomUUID(),
    operationId = randomUUID();
  const now = new Date().toISOString();
  const lock = message('booking', 'TicketRefundLockRequested.v1', orderId, 1, {
    orderId,
    saleId,
    organizationId,
    operationId,
    seatIds: ['r1-s1'],
    deadline: new Date(Date.now() + 60000).toISOString(),
  });
  const confirmation = message('booking', 'OrderConfirmed.v1', orderId, 2, {
    orderId,
    saleId,
    organizationId,
    buyerSubject: 'buyer',
    attemptId: randomUUID(),
    providerPaymentId: 'fake_payment',
    title: 'Concert',
    currency: 'EUR',
    totalMinor: 2500,
    confirmedAt: now,
    items: [{ seatId: 'r1-s1', row: 1, number: 1, categoryName: 'Standard', priceMinor: 2500 }],
  });
  const revoked = message('booking', 'OrderRefunded.v1', orderId, 3, {
    orderId,
    saleId,
    organizationId,
    operationId,
    attemptId: confirmation.data.attemptId,
    providerPaymentId: 'fake_payment',
    state: 'REFUNDED',
    seatCount: 1,
    totalMinor: 2500,
    currency: 'EUR',
    createdAt: now,
    expiresAt: now,
    confirmedAt: now,
    refundedAt: now,
  });
  const qr = new QrCredentials(process.env.TICKET_QR_KEYS),
    refunds = new TicketRefunds(db),
    issue = new IssueTickets(db, qr);
  return {
    orderId,
    lock,
    confirmation,
    revoked,
    refunds,
    issue,
    async scan() {
      const ticket = await db.ticket.findFirstOrThrow({ where: { orderId } });
      return new CheckInTicket(db).run(
        'staff',
        { requestId: randomUUID(), eventId: saleId, organizationId, credential: qr.reveal(ticket) },
        {
          admissionStartsAt: new Date(Date.now() - 60000).toISOString(),
          admissionEndsAt: new Date(Date.now() + 60000).toISOString(),
        },
      );
    },
  };
}

test('a refund fence survives late issuance, replay and revocation without restoring tickets', async () => {
  const fixture = await ticketsDatabase();
  try {
    const f = flow(fixture.db);
    await f.refunds.handle(f.lock);
    await f.issue.handle(f.confirmation);
    assert.equal((await f.scan()).result, 'REFUND_PENDING');
    assert.equal(await fixture.db.deliveryJob.count(), 0);
    await f.refunds.handle({ ...f.lock, eventId: randomUUID() });
    await assert.rejects(
      f.refunds.handle({
        ...f.lock,
        eventId: randomUUID(),
        data: { ...f.lock.data, operationId: randomUUID() },
      }),
      /Conflicting refund lock/,
    );
    await f.refunds.handle(f.revoked);
    await f.issue.handle({ ...f.confirmation, eventId: randomUUID() });
    assert.equal((await f.scan()).result, 'REFUNDED');
    assert.equal(await fixture.db.ticket.count(), 1);
    const ticket = await fixture.db.ticket.findFirstOrThrow();
    await assert.rejects(
      fixture.db.ticket.update({ where: { id: ticket.id }, data: { usedAt: new Date() } }),
      /Admission is blocked by refund/,
    );
    const beforeIssue = flow(fixture.db);
    await beforeIssue.refunds.handle(beforeIssue.revoked);
    await beforeIssue.issue.handle(beforeIssue.confirmation);
    assert.equal(await fixture.db.ticket.count({ where: { orderId: beforeIssue.orderId } }), 0);
  } finally {
    await fixture.close();
  }
});

test('scan and refund fence have exactly one winner in either arrival order', async () => {
  const fixture = await ticketsDatabase();
  try {
    for (let i = 0; i < 10; i++) {
      const f = flow(fixture.db);
      await f.issue.handle(f.confirmation);
      let scan;
      if (i % 2 === 0) [scan] = await Promise.all([f.scan(), f.refunds.handle(f.lock)]);
      else [, scan] = await Promise.all([f.refunds.handle(f.lock), f.scan()]);
      const gate = await fixture.db.refundGate.findUniqueOrThrow({ where: { orderId: f.orderId } });
      if (scan.result === 'ADMITTED') {
        assert.equal(gate.state, 'REJECTED');
        assert.equal(gate.code, 'TICKETS_USED');
      } else {
        assert.equal(scan.result, 'REFUND_PENDING');
        assert.equal(gate.state, 'LOCKED');
      }
    }
  } finally {
    await fixture.close();
  }
});

test('refund fences reject closed deadlines and ticket-set mismatches without disabling admission', async () => {
  const fixture = await ticketsDatabase();
  try {
    const expired = flow(fixture.db);
    await expired.issue.handle(expired.confirmation);
    await expired.refunds.handle({
      ...expired.lock,
      data: { ...expired.lock.data, deadline: new Date(Date.now() - 1).toISOString() },
    });
    assert.equal(
      (await fixture.db.refundGate.findUniqueOrThrow({ where: { orderId: expired.orderId } })).code,
      'REFUND_WINDOW_CLOSED',
    );
    assert.equal((await expired.scan()).result, 'ADMITTED');
    const mismatch = flow(fixture.db);
    await mismatch.issue.handle(mismatch.confirmation);
    await mismatch.refunds.handle({
      ...mismatch.lock,
      data: { ...mismatch.lock.data, seatIds: ['r1-s2'] },
    });
    assert.equal(
      (await fixture.db.refundGate.findUniqueOrThrow({ where: { orderId: mismatch.orderId } }))
        .code,
      'TICKET_MISMATCH',
    );
    assert.equal((await mismatch.scan()).result, 'ADMITTED');
  } finally {
    await fixture.close();
  }
});
