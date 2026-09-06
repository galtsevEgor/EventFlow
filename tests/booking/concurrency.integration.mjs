import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { bookingFixture } from '../helpers/booking.mjs';
import { cleanBroker } from '../helpers/broker.mjs';
import { seedSale } from '../helpers/sale.mjs';
import { testIdentity, jsonRequest } from '../helpers/identity.mjs';
import { ageOrder } from '../helpers/order.mjs';
import { eventually } from '../helpers/eventually.mjs';
import { createApplication } from '../../packages/service-runtime/dist/index.js';
import { AppModule } from '../../services/booking/dist/app.module.js';
import { OrderSweeper } from '../../services/booking/dist/orders/sweeper.js';
import { ChangeAvailability } from '../../services/booking/dist/availability.js';
import { message } from '../../packages/event-contracts/dist/index.js';
import { transaction } from '../../services/booking/dist/orders/transaction.js';

const namespace = `eventflow-test-${randomUUID()}`;
let fixture, identity, second, secondOrigin;
const reserve = (origin, token, saleId, seatIds, key = randomUUID()) =>
  jsonRequest(origin, '/api/v1/orders', token, 'POST', { saleId, seatIds }, key);
async function startReplica() {
  second = await createApplication(
    AppModule.configure({
      BOOKING_DATABASE_URL: fixture.databaseUrl,
      AMQP_URL: process.env.AMQP_URL,
      MESSAGE_NAMESPACE: namespace,
      OIDC_ISSUER: identity.issuer,
    }),
  );
  second.useLogger(false);
  await second.listen(0, '127.0.0.1');
  secondOrigin = await second.getUrl();
  await second.get(OrderSweeper).stop();
}
before(async () => {
  identity = await testIdentity();
  fixture = await bookingFixture(namespace, 0, { OIDC_ISSUER: identity.issuer });
  await fixture.app.get(OrderSweeper).stop();
  await startReplica();
});
after(async () => {
  await second?.close();
  await fixture?.close();
  await identity?.close();
  await cleanBroker(namespace);
});

test('100 HTTP buyers across two instances produce exactly one winner for the last seat', async () => {
  const sale = await seedSale(fixture.db, { seats: 1 });
  const tokens = await Promise.all(
    Array.from({ length: 100 }, (_, i) => identity.token(`buyer-${i}`)),
  );
  const responses = await Promise.all(
    tokens.map((token, i) =>
      reserve(i % 2 ? fixture.origin : secondOrigin, token, sale.id, ['r1-s1']),
    ),
  );
  assert.equal(responses.filter((r) => r.status === 201).length, 1);
  assert.equal(
    responses.filter((r) => r.status === 409 && r.body.code === 'SEATS_UNAVAILABLE').length,
    99,
  );
  assert.equal(await fixture.db.order.count({ where: { saleId: sale.id } }), 1);
  const seat = await fixture.db.seatInventory.findFirst({ where: { saleId: sale.id } });
  assert.equal(seat.currentOrderId, responses.find((r) => r.status === 201).body.id);
});

test('parallel idempotent retries and another process restart return the original order', async () => {
  const sale = await seedSale(fixture.db);
  const token = await identity.token('retry-buyer');
  const key = randomUUID();
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      reserve(
        i % 2 ? fixture.origin : secondOrigin,
        token,
        sale.id,
        i % 2 ? ['r1-s1', 'r1-s2'] : ['r1-s2', 'r1-s1'],
        key,
      ),
    ),
  );
  for (const response of responses) {
    assert.equal(response.status, 201);
    assert.deepEqual(response.body, responses[0].body);
  }
  await second.close();
  await startReplica();
  assert.deepEqual(
    (await reserve(secondOrigin, token, sale.id, ['r1-s1', 'r1-s2'], key)).body,
    responses[0].body,
  );
  assert.equal(await fixture.db.order.count({ where: { saleId: sale.id } }), 1);
});

test('different keys on two devices cannot bypass the buyer/event slot', async () => {
  const sale = await seedSale(fixture.db);
  const token = await identity.token('devices');
  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      reserve(i % 2 ? fixture.origin : secondOrigin, token, sale.id, [`r1-s${(i % 8) + 1}`]),
    ),
  );
  assert.equal(responses.filter((r) => r.status === 201).length, 1);
  assert.equal(responses.filter((r) => r.body.code === 'ACTIVE_ORDER').length, 11);
  assert.equal(await fixture.db.order.count({ where: { saleId: sale.id, state: 'HELD' } }), 1);
});

test('reversed overlapping sets racing expiry and cancellation never deadlock or partially reserve', async () => {
  const a = await identity.token('overlap-a'),
    b = await identity.token('overlap-b');
  for (let round = 0; round < 5; round++) {
    const sale = await seedSale(fixture.db);
    const oldA = (await reserve(fixture.origin, a, sale.id, ['r1-s1', 'r1-s2'])).body;
    const oldB = (await reserve(secondOrigin, b, sale.id, ['r1-s3', 'r1-s4'])).body;
    await ageOrder(fixture.db, oldA.id);
    await ageOrder(fixture.db, oldB.id);
    const [first, next] = await Promise.all([
      reserve(fixture.origin, a, sale.id, ['r1-s2', 'r1-s3']),
      reserve(secondOrigin, b, sale.id, ['r1-s3', 'r1-s2']),
      fixture.app.get(OrderSweeper).sweep(),
      second.get(OrderSweeper).sweep(),
      jsonRequest(fixture.origin, `/api/v1/orders/${oldA.id}/cancel`, a, 'POST'),
      jsonRequest(secondOrigin, `/api/v1/orders/${oldB.id}/cancel`, b, 'POST'),
    ]);
    assert.deepEqual([first.status, next.status].sort(), [201, 409]);
    const held = await fixture.db.order.findMany({
      where: { saleId: sale.id, state: 'HELD' },
      include: { items: true },
    });
    assert.equal(held.length, 1);
    assert.equal(held[0].items.length, 2);
    const seats = await fixture.db.seatInventory.findMany({
      where: { saleId: sale.id, state: 'HELD' },
    });
    assert.equal(seats.length, 2);
    assert.ok(seats.every((s) => s.currentOrderId === held[0].id));
    assert.equal(
      await fixture.db.order.count({ where: { id: { in: [oldA.id, oldB.id] }, state: 'EXPIRED' } }),
      2,
    );
  }
});

async function waitAcrossDeadline(saleId, deadline, request) {
  const blocker = new pg.Client({ connectionString: fixture.databaseUrl });
  await blocker.connect();
  let result;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT * FROM "SeatInventory" WHERE "saleId"=$1 FOR UPDATE', [saleId]);
    result = request();
    await eventually(
      () =>
        fixture.db
          .$queryRaw`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SeatInventory%'`,
      (rows) => rows[0].count > 0,
      4000,
    );
    await eventually(
      () => fixture.db.$queryRaw`SELECT clock_timestamp() >= ${deadline} AS passed`,
      (rows) => rows[0].passed,
      4000,
    );
    await blocker.query('COMMIT');
    return await result;
  } finally {
    await blocker.query('ROLLBACK');
    await blocker.end();
    await result;
  }
}

test('decision time after a SQL wait rejects closed sales and permits an expired-seat takeover', async () => {
  const buyer = await identity.token('deadline');
  const [clock] = await fixture.db.$queryRaw`SELECT clock_timestamp() AS now`;
  const end = new Date(+clock.now + 2000);
  const sale = await seedSale(fixture.db, { salesEndsAt: end });
  const closed = await waitAcrossDeadline(sale.id, end, () =>
    reserve(fixture.origin, buyer, sale.id, ['r1-s1']),
  );
  assert.equal(closed.body.code, 'SALES_NOT_OPEN');
  assert.equal(await fixture.db.order.count({ where: { saleId: sale.id } }), 0);
  const next = await seedSale(fixture.db);
  const old = (await reserve(fixture.origin, buyer, next.id, ['r1-s1'])).body;
  const [current] = await fixture.db.$queryRaw`SELECT clock_timestamp() AS now`;
  const expiry = new Date(+current.now + 2000);
  await ageOrder(fixture.db, old.id, expiry);
  const takeover = await waitAcrossDeadline(next.id, expiry, async () =>
    reserve(secondOrigin, await identity.token('takeover'), next.id, ['r1-s1']),
  );
  assert.equal(takeover.status, 201);
  assert.ok(new Date(takeover.body.serverNow) >= expiry);
});

test('acknowledged pause rejects new buyers while preserving an existing hold', async () => {
  const sale = await seedSale(fixture.db);
  const token = await identity.token('pause');
  const held = (await reserve(fixture.origin, token, sale.id, ['r1-s1'])).body;
  await new ChangeAvailability(fixture.db).handle(
    message('catalog', 'SaleAvailabilityRequested.v1', sale.id, 1, {
      commandVersion: 1,
      paused: true,
    }),
  );
  assert.equal(
    (await reserve(secondOrigin, await identity.token('late'), sale.id, ['r1-s2'])).body.code,
    'SALES_NOT_OPEN',
  );
  assert.equal(
    (await jsonRequest(fixture.origin, `/api/v1/orders/${held.id}`, token)).body.state,
    'HELD',
  );
});

test('database serialization conflicts retry at most three times and report a retryable failure', async () => {
  let attempts = 0;
  await transaction(fixture.db, async (tx) => {
    attempts++;
    if (attempts < 3)
      await tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'test serialization conflict'; END $$`;
  });
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(
    transaction(fixture.db, async (tx) => {
      attempts++;
      await tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '40P01', MESSAGE = 'test deadlock conflict'; END $$`;
    }),
    (error) => error.getStatus?.() === 503 && error.getResponse().code === 'BOOKING_BUSY',
  );
  assert.equal(attempts, 3);
  await assert.rejects(
    transaction(
      fixture.db,
      (tx) =>
        tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '57014', MESSAGE = 'test statement timeout'; END $$`,
    ),
    (error) => error.getStatus?.() === 503,
  );
});
