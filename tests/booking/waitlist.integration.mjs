import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bookingFixture } from '../helpers/booking.mjs';
import { testIdentity, jsonRequest } from '../helpers/identity.mjs';
import { seedSale } from '../helpers/sale.mjs';
import { cleanBroker } from '../helpers/broker.mjs';
import { Reserve } from '../../services/booking/dist/orders/reserve.js';
import {
  lockOrder,
  lockSeats,
  lockSlot,
  transaction,
  decisionTime,
} from '../../services/booking/dist/orders/transaction.js';
const namespace = 'eventflow-test-' + randomUUID();
let fixture, identity, machine;
before(async () => {
  identity = await testIdentity();
  fixture = await bookingFixture(namespace, 0, { OIDC_ISSUER: identity.issuer });
  machine = await identity.token('waitlist-service', {
    azp: 'eventflow-waitlist',
    realm_access: { roles: ['booking-waitlist'] },
  });
});
after(async () => {
  await fixture?.close();
  await identity?.close();
  await cleanBroker(namespace);
});
const body = (saleId, buyerSubject = 'waitlist-buyer') => ({
  saleId,
  buyerSubject,
  entryId: randomUUID(),
  requestId: randomUUID(),
  categoryId: 'standard',
  email: 'buyer@eventflow.test',
});
const create = (d) =>
  jsonRequest(fixture.origin, '/internal/waitlist/reservations', machine, 'POST', d);
test('only the waitlist service can create scoped offers; public input stays strict', async () => {
  const sale = await seedSale(fixture.db),
    user = await identity.token();
  assert.equal(
    (
      await jsonRequest(
        fixture.origin,
        '/internal/waitlist/reservations',
        user,
        'POST',
        body(sale.id),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await jsonRequest(
        fixture.origin,
        '/internal/waitlist/reservations',
        null,
        'POST',
        body(sale.id),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await jsonRequest(
        fixture.origin,
        '/api/v1/orders',
        user,
        'POST',
        { saleId: sale.id, seatIds: ['r1-s1'], waitlistEntryId: randomUUID() },
        randomUUID(),
      )
    ).status,
    422,
  );
});
test('category reservation takes one correct seat at the authoritative price and replays a lost response', async () => {
  const sale = await seedSale(fixture.db);
  await fixture.db.seatInventory.update({
    where: { saleId_seatId: { saleId: sale.id, seatId: 'r1-s1' } },
    data: { categoryId: 'vip', priceMinor: 9900 },
  });
  const d = body(sale.id, 'retry-buyer');
  const all = await Promise.all(Array.from({ length: 12 }, () => create(d)));
  assert.ok(all.every((r) => r.status === 201));
  assert.equal(new Set(all.map((r) => r.body.id)).size, 1);
  assert.equal(all[0].body.items.length, 1);
  assert.equal(all[0].body.items[0].seatId, 'r1-s2');
  assert.equal(all[0].body.totalMinor, 2501);
  assert.equal(
    (await fixture.db.order.findUnique({ where: { id: all[0].body.id } })).waitlistEntryId,
    d.entryId,
  );
});
test('automatic offers race safely with normal buyers for the last seat', async () => {
  const sale = await seedSale(fixture.db, { seats: 1 }),
    reserve = fixture.app.get(Reserve);
  const results = await Promise.all([
    create(body(sale.id, 'auto-race')),
    ...Array.from({ length: 20 }, (_, i) =>
      reserve.run('normal-' + i, randomUUID(), { saleId: sale.id, seatIds: ['r1-s1'] }),
    ),
  ]);
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 20);
  assert.equal(await fixture.db.order.count({ where: { saleId: sale.id } }), 1);
});
test('offer cancellation is scoped by entry and buyer and never touches normal orders', async () => {
  const sale = await seedSale(fixture.db),
    d = body(sale.id, 'cancel-buyer'),
    offer = await create(d);
  assert.equal(offer.status, 201);
  assert.equal(
    (
      await jsonRequest(fixture.origin, '/internal/waitlist/cancel', machine, 'POST', {
        entryId: d.entryId,
        buyerSubject: 'another-buyer',
      })
    ).status,
    404,
  );
  const cancelled = await jsonRequest(
    fixture.origin,
    '/internal/waitlist/cancel',
    machine,
    'POST',
    { entryId: d.entryId, buyerSubject: d.buyerSubject },
  );
  assert.equal(cancelled.body.state, 'CANCELLED');
  const normal = await fixture.app
    .get(Reserve)
    .run(d.buyerSubject, randomUUID(), { saleId: sale.id, seatIds: ['r1-s2'] });
  await jsonRequest(fixture.origin, '/internal/waitlist/cancel', machine, 'POST', {
    entryId: d.entryId,
    buyerSubject: d.buyerSubject,
  });
  assert.equal(
    (await fixture.db.order.findUnique({ where: { id: normal.body.id } })).state,
    'HELD',
  );
});
test('already purchased and paused sales do not produce offers', async () => {
  const sale = await seedSale(fixture.db),
    reserve = fixture.app.get(Reserve),
    buyer = 'purchased-buyer';
  const paid = await reserve.run(buyer, randomUUID(), { saleId: sale.id, seatIds: ['r1-s1'] });
  await fixture.db.order.update({
    where: { id: paid.body.id },
    data: { state: 'CONFIRMED', confirmedAt: new Date() },
  });
  await fixture.db.buyerSaleSlot.update({
    where: { buyerSubject_saleId: { buyerSubject: buyer, saleId: sale.id } },
    data: { currentOrderId: null },
  });
  assert.equal((await create(body(sale.id, buyer))).body.code, 'ALREADY_PURCHASED');
  await fixture.db.sale.update({ where: { id: sale.id }, data: { paused: true } });
  assert.equal((await create(body(sale.id, 'paused-buyer'))).body.code, 'SALES_NOT_OPEN');
});
test('status waits for a payment that owns the locks across the expiry boundary', async () => {
  const sale = await seedSale(fixture.db),
    d = body(sale.id, 'boundary-buyer'),
    offer = await create(d);
  assert.equal(offer.status, 201);
  const id = offer.body.id,
    expiresAt = new Date(Date.now() + 300);
  await fixture.db.order.update({ where: { id }, data: { expiresAt } });
  let release, locked;
  const hold = new Promise((resolve) => {
      release = resolve;
    }),
    ready = new Promise((resolve) => {
      locked = resolve;
    });
  const confirm = transaction(fixture.db, async (tx) => {
    await lockSlot(tx, d.buyerSubject, sale.id);
    const order = await lockOrder(tx, id);
    await lockSeats(tx, sale.id, ['r1-s1']);
    assert.ok((await decisionTime(tx)) < order.expiresAt);
    locked();
    await hold;
    await tx.order.update({ where: { id }, data: { state: 'CONFIRMED', confirmedAt: new Date() } });
  });
  try {
    await ready;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, +expiresAt - Date.now() + 20)));
    let finished = false;
    const result = jsonRequest(fixture.origin, '/internal/waitlist/status', machine, 'POST', {
      entryId: d.entryId,
      buyerSubject: d.buyerSubject,
    }).then((r) => {
      finished = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(finished, false);
    release();
    await confirm;
    assert.equal((await result).body.state, 'CONFIRMED');
  } finally {
    release();
    await confirm;
  }
});
