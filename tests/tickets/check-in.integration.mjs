import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { CheckInTicket } from '../../services/tickets/dist/check-in.js';
import { QrCredentials } from '../../services/tickets/dist/qr-credentials.js';
import { ticketsDatabase } from '../helpers/tickets-database.mjs';

test('check-in fences concurrent staff, persists the first admission and replays a lost reply', async () => {
  const fixture = await ticketsDatabase();
  const { db } = fixture;
  try {
    const qr = new QrCredentials(`v1:${randomBytes(32).toString('hex')}`);
    const id = randomUUID();
    const eventId = randomUUID();
    const organizationId = randomUUID();
    const record = {
      id,
      orderId: randomUUID(),
      saleId: eventId,
      organizationId,
      seatId: 'r1-s1',
      row: 1,
      number: 1,
      categoryName: 'Standard',
      buyerSubject: 'buyer',
      ...qr.issue(id),
    };
    await db.ticket.create({ data: record });
    const credential = qr.reveal(record);
    const open = {
      admissionStartsAt: new Date(Date.now() - 60000).toISOString(),
      admissionEndsAt: new Date(Date.now() + 60000).toISOString(),
    };
    const closed = { ...open, admissionStartsAt: new Date(Date.now() + 30000).toISOString() };
    const base = { requestId: randomUUID(), organizationId, eventId, credential };
    const scan = new CheckInTicket(db);
    const denied = [
      await scan.run('staff-1', { ...base, requestId: randomUUID() }, closed),
      await scan.run('staff-1', { ...base, requestId: randomUUID(), eventId: randomUUID() }, open),
      await scan.run(
        'staff-1',
        { ...base, requestId: randomUUID(), credential: randomBytes(24).toString('base64url') },
        open,
      ),
    ];
    assert.deepEqual(
      denied.map(({ result }) => result),
      ['WINDOW_CLOSED', 'WRONG_EVENT', 'INVALID_TICKET'],
    );
    assert.equal((await db.ticket.findUnique({ where: { id } })).usedAt, null);

    const requests = [base, { ...base, requestId: randomUUID() }];
    const results = await Promise.all(
      requests.map((request, index) => scan.run(`staff-${index + 1}`, request, open)),
    );
    assert.deepEqual(results.map(({ result }) => result).sort(), ['ADMITTED', 'ALREADY_USED']);
    assert.deepEqual(results[0].admittedAt, results[1].admittedAt);
    const winner = results.findIndex(({ result }) => result === 'ADMITTED');
    const replay = await scan.run(`staff-${winner + 1}`, requests[winner], closed);
    assert.deepEqual(replay, results[winner]);
    await assert.rejects(
      () => scan.run('different-actor', requests[winner], open),
      (error) => error.getStatus() === 409,
    );
    const audit = await db.checkIn.findMany({ where: { result: 'ADMITTED' } });
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actorSubject, `staff-${winner + 1}`);
    assert.equal(audit[0].ticketId, id);
    assert.ok(!JSON.stringify(audit).includes(credential));
  } finally {
    await fixture.close();
  }
});
