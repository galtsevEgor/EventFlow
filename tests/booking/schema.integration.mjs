import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { bookingFixture } from '../helpers/booking.mjs';
import { cleanBroker } from '../helpers/broker.mjs';
import { seedSale } from '../helpers/sale.mjs';
import { effectiveState } from '../../services/booking/dist/orders/transaction.js';
import { ORDER_HOLD_DURATION_MS } from '../../services/booking/dist/orders/reserve.js';
import { MAX_ORDER_TOTAL_MINOR } from '../../packages/event-contracts/dist/index.js';

const namespace = `eventflow-test-${randomUUID()}`;
let fixture;
before(async () => {
  fixture = await bookingFixture(namespace);
});
after(async () => {
  await fixture?.close();
  await cleanBroker(namespace);
});

test('database rejects invalid holds, cross-sale ownership, negative prices and excessive expiry', async () => {
  const db = fixture.db;
  const sale = await seedSale(db);
  const another = await seedSale(db);
  const now = new Date();
  const data = {
    id: randomUUID(),
    saleId: sale.id,
    buyerSubject: 'buyer',
    organizationId: sale.organizationId,
    title: sale.title,
    currency: 'EUR',
    totalMinor: 2500,
    createdAt: now,
    expiresAt: new Date(+now + ORDER_HOLD_DURATION_MS),
  };
  await assert.rejects(db.order.create({ data: { ...data, totalMinor: -1 } }));
  await assert.rejects(
    db.order.create({ data: { ...data, totalMinor: MAX_ORDER_TOTAL_MINOR + 1 } }),
  );
  await assert.rejects(
    db.order.create({ data: { ...data, expiresAt: new Date(+now + ORDER_HOLD_DURATION_MS + 1) } }),
  );
  await db.order.create({ data });
  await assert.rejects(
    db.seatInventory.update({
      where: { saleId_seatId: { saleId: sale.id, seatId: 'r1-s1' } },
      data: { state: 'HELD' },
    }),
  );
  await assert.rejects(
    db.seatInventory.update({
      where: { saleId_seatId: { saleId: another.id, seatId: 'r1-s1' } },
      data: { state: 'HELD', currentOrderId: data.id, expiresAt: data.expiresAt },
    }),
  );
  await assert.rejects(
    db.buyerSaleSlot.create({
      data: { buyerSubject: 'other', saleId: sale.id, currentOrderId: data.id },
    }),
  );
  assert.equal(
    (await db.seatInventory.findMany({ where: { saleId: sale.id } })).every(
      (s) => s.state === 'AVAILABLE',
    ),
    true,
  );
});

test('effective expiry includes the exact boundary and never changes terminal states', () => {
  const expiresAt = new Date('2030-01-01T00:00:00Z');
  assert.equal(effectiveState({ state: 'HELD', expiresAt }, new Date(+expiresAt - 1)), 'HELD');
  assert.equal(effectiveState({ state: 'HELD', expiresAt }, expiresAt), 'EXPIRED');
  assert.equal(
    effectiveState({ state: 'CONFIRMED', expiresAt }, new Date(+expiresAt + 1)),
    'CONFIRMED',
  );
});

test('database diagnostics observe slow queries and pool usage without SQL or credentials', async () => {
  fixture.db.resetQueryMetrics();
  await fixture.db.$executeRaw`SELECT pg_sleep(0.15)`;
  const snapshot = fixture.db.diagnostics();
  assert.ok(snapshot.queries.count >= 1);
  assert.ok(snapshot.queries.slow >= 1);
  assert.ok(snapshot.queries.maxMs >= 140);
  assert.ok(snapshot.pool.total >= 1 && snapshot.pool.total <= snapshot.pool.limit);
  assert.doesNotMatch(JSON.stringify(snapshot), /postgresql|password|pg_sleep|SELECT/);
});
