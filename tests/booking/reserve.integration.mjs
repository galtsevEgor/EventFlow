import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { bookingFixture } from '../helpers/booking.mjs';
import { cleanBroker } from '../helpers/broker.mjs';
import { seedSale } from '../helpers/sale.mjs';
import { testIdentity, jsonRequest } from '../helpers/identity.mjs';

const namespace = `eventflow-test-${randomUUID()}`;
let fixture, identity, buyer;
const request = (...args) => jsonRequest(fixture.origin, ...args);
const reserve = (token, saleId, seatIds, key = randomUUID()) =>
  request('/api/v1/orders', token, 'POST', { saleId, seatIds }, key);
before(async () => {
  identity = await testIdentity();
  fixture = await bookingFixture(namespace, 0, { OIDC_ISSUER: identity.issuer });
  buyer = await identity.token();
});
after(async () => {
  await fixture?.close();
  await identity?.close();
  await cleanBroker(namespace);
});

test('reserve snapshots authoritative prices and replays the original result after a lost response', async () => {
  const sale = await seedSale(fixture.db);
  const key = randomUUID();
  const first = await reserve(buyer, sale.id, ['r1-s2', 'r1-s1'], key);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.totalMinor, 5001);
  assert.equal(+new Date(first.body.expiresAt) - +new Date(first.body.serverNow), 600000);
  const again = await reserve(buyer, sale.id, ['r1-s1', 'r1-s2'], key);
  assert.deepEqual(again.body, first.body);
  assert.equal((await reserve(buyer, sale.id, ['r1-s3'], key)).body.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await reserve(buyer, sale.id, ['r1-s3'])).body.code, 'ACTIVE_ORDER');
  const read = await request(`/api/v1/orders/${first.body.id}`, buyer);
  assert.equal(read.body.id, first.body.id);
  assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.equal(
    (await request(`/api/v1/orders/${first.body.id}`, await identity.token('outsider'))).status,
    404,
  );
  const list = await request(`/api/v1/orders?saleId=${sale.id}`, buyer);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items[0].id, first.body.id);
});

test('identity, invalid selection, forged price and wrong event never mutate inventory', async () => {
  const sale = await seedSale(fixture.db);
  for (const token of [
    undefined,
    await identity.token('x', { aud: 'eventflow-catalog' }),
    await identity.token('x', { azp: 'eventflow-policy' }),
  ])
    assert.equal((await reserve(token, sale.id, ['r1-s1'])).status, 401);
  assert.equal(
    (await reserve(await identity.token('x', { email_verified: false }), sale.id, ['r1-s1']))
      .status,
    403,
  );
  for (const seats of [
    [],
    ['r1-s1', 'r1-s1'],
    Array.from({ length: 7 }, (_, i) => `r1-s${i + 1}`),
    ['r2-s1'],
  ])
    assert.equal((await reserve(buyer, sale.id, seats)).status, 422);
  assert.equal(
    (
      await request(
        '/api/v1/orders',
        buyer,
        'POST',
        { saleId: sale.id, seatIds: ['r1-s1'], totalMinor: 1 },
        randomUUID(),
      )
    ).status,
    422,
  );
  assert.equal(
    (await request('/api/v1/orders', buyer, 'POST', { saleId: sale.id, seatIds: ['r1-s1'] }))
      .status,
    422,
  );
  assert.equal(await fixture.db.order.count({ where: { saleId: sale.id } }), 0);
});

test('selection is all-or-nothing and business conflicts are replayable', async () => {
  const sale = await seedSale(fixture.db);
  await reserve(buyer, sale.id, ['r1-s1']);
  const other = await identity.token('other');
  const key = randomUUID();
  assert.equal(
    (await reserve(other, sale.id, ['r1-s1', 'r1-s2', 'r1-s3'], key)).body.code,
    'SEATS_UNAVAILABLE',
  );
  assert.equal((await reserve(other, sale.id, ['r1-s1', 'r1-s2', 'r1-s3'], key)).status, 409);
  assert.equal(await fixture.db.order.count({ where: { saleId: sale.id } }), 1);
  assert.equal(
    await fixture.db.seatInventory.count({ where: { saleId: sale.id, state: 'AVAILABLE' } }),
    7,
  );
});

test('sales window caps expiry and pause prevents only new holds', async () => {
  const sale = await seedSale(fixture.db, { salesEndsAt: new Date(Date.now() + 60000) });
  const held = await reserve(buyer, sale.id, ['r1-s1']);
  assert.equal(held.body.expiresAt, sale.salesEndsAt.toISOString());
  await fixture.db.sale.update({ where: { id: sale.id }, data: { paused: true } });
  assert.equal(
    (await reserve(await identity.token('other'), sale.id, ['r1-s2'])).body.code,
    'SALES_NOT_OPEN',
  );
  assert.equal((await request(`/api/v1/orders/${held.body.id}`, buyer)).body.state, 'HELD');
  const future = await seedSale(fixture.db, { salesStartsAt: new Date(Date.now() + 60000) });
  assert.equal((await reserve(buyer, future.id, ['r1-s1'])).body.code, 'SALES_NOT_OPEN');
});
