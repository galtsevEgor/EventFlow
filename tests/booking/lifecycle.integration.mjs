import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { bookingFixture } from '../helpers/booking.mjs';
import { cleanBroker } from '../helpers/broker.mjs';
import { seedSale } from '../helpers/sale.mjs';
import { testIdentity, jsonRequest } from '../helpers/identity.mjs';
import { OrderSweeper } from '../../services/booking/dist/orders/sweeper.js';
import { ageOrder } from '../helpers/order.mjs';
import { eventually } from '../helpers/eventually.mjs';

const namespace = `eventflow-test-${randomUUID()}`;
let fixture, identity, buyer, sweeper;
const request = (...args) => jsonRequest(fixture.origin, ...args);
const reserve = (token, saleId, seatIds) =>
  request('/api/v1/orders', token, 'POST', { saleId, seatIds }, randomUUID());
before(async () => {
  identity = await testIdentity();
  fixture = await bookingFixture(namespace, 0, { OIDC_ISSUER: identity.issuer });
  buyer = await identity.token();
  sweeper = fixture.app.get(OrderSweeper);
  await sweeper.stop();
});
after(async () => {
  await fixture?.close();
  await identity?.close();
  await cleanBroker(namespace);
});

test('cancellation releases the whole order, emits one event and never allows another buyer', async () => {
  const sale = await seedSale(fixture.db);
  const held = (await reserve(buyer, sale.id, ['r1-s1', 'r1-s2'])).body;
  const path = `/api/v1/orders/${held.id}/cancel`;
  assert.equal((await request(path, await identity.token('outsider'), 'POST')).status, 404);
  for (let i = 0; i < 2; i++)
    assert.equal((await request(path, buyer, 'POST')).body.state, 'CANCELLED');
  assert.equal(
    await fixture.db.seatInventory.count({ where: { saleId: sale.id, state: 'AVAILABLE' } }),
    8,
  );
  const events = await fixture.db.outbox.findMany();
  assert.equal(
    events.filter(
      (e) => e.envelope.aggregateId === held.id && e.envelope.eventType === 'OrderCancelled.v1',
    ).length,
    1,
  );
});

test('inline expiry permits takeover and stale cleanup preserves the new owner', async () => {
  const sale = await seedSale(fixture.db);
  const old = (await reserve(buyer, sale.id, ['r1-s1', 'r1-s2'])).body;
  await ageOrder(fixture.db, old.id);
  const available = await request(`/api/v1/sales/${sale.id}`);
  assert.equal(available.body.seats[0].state, 'AVAILABLE');
  assert.equal((await request(`/api/v1/orders/${old.id}`, buyer)).body.state, 'EXPIRED');
  const newer = await reserve(await identity.token('other'), sale.id, ['r1-s1']);
  assert.equal(newer.status, 201);
  assert.equal((await fixture.db.order.findUnique({ where: { id: old.id } })).state, 'HELD');
  await Promise.all([sweeper.sweep(), sweeper.sweep()]);
  assert.equal(
    (
      await fixture.db.seatInventory.findUnique({
        where: { saleId_seatId: { saleId: sale.id, seatId: 'r1-s1' } },
      })
    ).currentOrderId,
    newer.body.id,
  );
  assert.equal((await fixture.db.order.findUnique({ where: { id: old.id } })).state, 'EXPIRED');
  assert.equal(
    await fixture.db.seatInventory.count({ where: { saleId: sale.id, state: 'AVAILABLE' } }),
    7,
  );
  assert.equal(
    (await fixture.db.outbox.findMany()).filter((e) => e.envelope.aggregateId === old.id).length,
    1,
  );
});

test('buyer replaces an expired hold and sweeper catches up after restart', async () => {
  const sale = await seedSale(fixture.db);
  const old = (await reserve(buyer, sale.id, ['r1-s1', 'r1-s2'])).body;
  await ageOrder(fixture.db, old.id);
  const newer = await reserve(buyer, sale.id, ['r1-s2', 'r1-s3']);
  assert.equal(newer.status, 201);
  assert.equal((await fixture.db.order.findUnique({ where: { id: old.id } })).state, 'EXPIRED');
  await ageOrder(fixture.db, newer.body.id);
  sweeper.start();
  await eventually(
    async () =>
      (await fixture.db.order.findUnique({ where: { id: newer.body.id } })).state === 'EXPIRED',
    (value) => value,
  );
  await sweeper.stop();
  assert.equal(
    await fixture.db.seatInventory.count({ where: { saleId: sale.id, state: 'AVAILABLE' } }),
    8,
  );
});
