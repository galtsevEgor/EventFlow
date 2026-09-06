import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from 'amqplib';
import { catalogFixture } from '../services/catalog/tests/fixture.mjs';
import { bookingFixture } from './helpers/booking.mjs';
import { cleanBroker } from './helpers/broker.mjs';
import { ProvisionSale } from '../services/booking/dist/provision.js';
import { Broker, Outbox } from '../packages/messaging/dist/index.js';
import { saleRoutes } from '../packages/event-contracts/dist/index.js';

const namespace = `eventflow-test-${randomUUID()}`;
let catalog, booking, owner, eventPath, eventId, coverId, envelope;
export async function eventually(read, accept, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await delay(100);
  }
  assert.fail('Expected state was not reached before the deadline');
}
const configuration = {
  city: 'Chisinau',
  address: 'Music Street 12',
  timeZone: 'Europe/Chisinau',
  startsAt: '2035-06-01T16:00:00Z',
  endsAt: '2035-06-01T18:00:00Z',
  salesStartsAt: '2035-05-01T09:00:00Z',
  salesEndsAt: '2035-06-01T15:30:00Z',
  admissionStartsAt: '2035-06-01T15:00:00Z',
  admissionEndsAt: '2035-06-01T18:00:00Z',
  currency: 'EUR',
  categories: [{ id: 'standard', name: 'Standard', priceMinor: 2500 }],
  layout: {
    rows: 2,
    columns: 3,
    defaultCategoryId: 'standard',
    overrides: [{ row: 2, number: 3, categoryId: 'standard', disabled: true }],
  },
};
before(async () => {
  catalog = await catalogFixture({ AMQP_URL: process.env.AMQP_URL, MESSAGE_NAMESPACE: namespace });
  owner = await catalog.token();
  const org = await catalog.request('/api/v1/organizations', owner, 'POST', { name: 'Publisher' });
  eventPath = `/api/v1/organizations/${org.body.id}/events`;
  const draft = await catalog.request(eventPath, owner, 'POST', {
    title: 'Summer concert',
    description: 'Live music in the garden.',
  });
  eventId = draft.body.id;
  eventPath += `/${eventId}`;
});
after(async () => {
  await booking?.close();
  await catalog?.close();
  await cleanBroker(namespace);
});

test('publication validates completeness, revision and access before writing any outbox event', async () => {
  assert.equal(
    (await catalog.request(eventPath + '/publication', owner, 'POST', { revision: 0 })).status,
    422,
  );
  assert.equal(await catalog.db.outbox.count(), 0);
  assert.equal(
    (
      await catalog.request(eventPath + '/configuration', owner, 'PUT', {
        revision: 0,
        configuration,
      })
    ).status,
    200,
  );
  coverId = randomUUID();
  await catalog.db.coverAsset.create({
    data: {
      id: coverId,
      eventId,
      objectKey: `fixture/${coverId}.webp`,
      width: 100,
      height: 100,
      bytes: 100,
    },
  });
  await catalog.db.eventDraft.update({ where: { id: eventId }, data: { coverId } });
  assert.equal(
    (await catalog.request(eventPath + '/publication', owner, 'POST', { revision: 0 })).status,
    409,
  );
  const outsider = await catalog.token({ sub: randomUUID() });
  assert.equal(
    (await catalog.request(eventPath + '/publication', outsider, 'POST', { revision: 1 })).status,
    404,
  );
  assert.equal(await catalog.db.outbox.count(), 0);
});
test('Booking outage leaves publication pending; retry cannot change frozen prices or seats', async () => {
  const first = await catalog.request(eventPath + '/publication', owner, 'POST', { revision: 1 });
  assert.equal(first.status, 201);
  assert.equal(first.body.state, 'PROVISIONING');
  const second = await catalog.request(eventPath + '/publication', owner, 'POST', { revision: 1 });
  assert.equal(second.body.eventId, first.body.eventId);
  assert.equal(await catalog.db.outbox.count(), 1);
  assert.equal(
    (
      await catalog.request(eventPath + '/configuration', owner, 'PUT', {
        revision: 1,
        configuration,
      })
    ).body.code,
    'SALE_FROZEN',
  );
  const row = await eventually(
    () => catalog.db.outbox.findFirst(),
    (row) => row?.sentAt,
  );
  envelope = row.envelope;
  assert.equal(
    (await catalog.db.publication.findUnique({ where: { eventId } })).state,
    'PROVISIONING',
  );
  assert.equal(
    (await catalog.db.coverAsset.findUnique({ where: { id: coverId } })).isPublic,
    false,
  );
  booking = await bookingFixture(namespace);
  await eventually(
    () => catalog.db.publication.findUnique({ where: { eventId } }),
    (value) => value?.state === 'PUBLISHED',
  );
  assert.equal(await booking.db.sale.count(), 1);
  assert.equal(await booking.db.seatInventory.count(), 5);
  assert.equal((await booking.db.seatInventory.findFirst()).priceMinor, 2500);
  assert.equal((await catalog.db.coverAsset.findUnique({ where: { id: coverId } })).isPublic, true);
});
test('lost publisher confirmations and replayed commands do not duplicate inventory or overwrite the snapshot', async () => {
  await catalog.db.outbox.updateMany({ data: { sentAt: null, availableAt: new Date(0) } });
  await booking.db.outbox.updateMany({ data: { sentAt: null, availableAt: new Date(0) } });
  await eventually(
    () => catalog.db.outbox.findFirst(),
    (row) => row?.sentAt && row.attempts >= 2,
  );
  await eventually(
    () => booking.db.outbox.findFirst(),
    (row) => row?.sentAt && row.attempts >= 2,
  );
  const handler = new ProvisionSale(booking.db);
  await handler.handle({ ...envelope, eventId: randomUUID() });
  await assert.rejects(
    handler.handle({
      ...envelope,
      eventId: randomUUID(),
      data: {
        ...envelope.data,
        seats: envelope.data.seats.map((seat) => ({ ...seat, priceMinor: 1 })),
      },
    }),
    /Frozen sale conflict/,
  );
  await assert.rejects(
    handler.handle({ ...envelope, eventId: randomUUID(), aggregateVersion: 2 }),
    /Invalid sale snapshot/,
  );
  assert.equal(await booking.db.seatInventory.count(), 5);
  assert.equal((await booking.db.seatInventory.findFirst()).priceMinor, 2500);
  assert.equal(await booking.db.inbox.count(), 2);
});
test('malformed messages are confirmed into a dead-letter queue instead of looping or touching domain data', async () => {
  const connection = await connect(process.env.AMQP_URL);
  try {
    const channel = await connection.createConfirmChannel();
    channel.sendToQueue(`${namespace}.booking`, Buffer.from('{invalid'), { persistent: true });
    await channel.waitForConfirms();
    await eventually(
      () => channel.checkQueue(`${namespace}.booking.dlq`),
      (queue) => queue.messageCount === 1,
    );
    assert.equal(await booking.db.sale.count(), 1);
  } finally {
    await connection.close();
  }
});
test('outbox leases are exclusive, survive a relay crash and reject a stale settlement', async () => {
  const isolated = await catalogFixture();
  try {
    const item = { ...envelope, eventId: randomUUID() };
    await isolated.db.outbox.create({ data: { id: item.eventId, envelope: item } });
    const outbox = new Outbox((sql, ...values) => isolated.db.$queryRawUnsafe(sql, ...values));
    const claims = await Promise.all([outbox.claim(), outbox.claim()]);
    assert.equal(claims.filter(Boolean).length, 1);
    const first = claims.find(Boolean);
    await isolated.db.outbox.update({
      where: { id: item.eventId },
      data: { availableAt: new Date(0) },
    });
    const recovered = await outbox.claim();
    assert.notEqual(first.lease, recovered.lease);
    await outbox.settle(first.id, first.lease, true, first.attempts);
    assert.equal((await isolated.db.outbox.findUnique({ where: { id: first.id } })).sentAt, null);
    await outbox.settle(recovered.id, recovered.lease, true, recovered.attempts);
    assert.ok((await isolated.db.outbox.findUnique({ where: { id: first.id } })).sentAt);
  } finally {
    await isolated.close();
  }
});

test('sale, seats, inbox and confirmation roll back together if outbox persistence fails', async () => {
  const id = randomUUID(),
    request = { ...envelope, eventId: randomUUID(), aggregateId: id };
  await booking.db.$executeRawUnsafe(
    `CREATE FUNCTION fail_test_outbox() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''injected outbox failure''; END'`,
  );
  await booking.db.$executeRawUnsafe(
    `CREATE TRIGGER fail_test_outbox BEFORE INSERT ON "Outbox" FOR EACH ROW EXECUTE FUNCTION fail_test_outbox()`,
  );
  try {
    await assert.rejects(new ProvisionSale(booking.db).handle(request), /injected outbox failure/);
    assert.equal(await booking.db.sale.count({ where: { id } }), 0);
    assert.equal(await booking.db.seatInventory.count({ where: { saleId: id } }), 0);
    assert.equal(await booking.db.inbox.count({ where: { eventId: request.eventId } }), 0);
  } finally {
    await booking.db.$executeRawUnsafe('DROP TRIGGER fail_test_outbox ON "Outbox"');
    await booking.db.$executeRawUnsafe('DROP FUNCTION fail_test_outbox()');
  }
});
test('unroutable publications fail; transient consumer errors retry with a delay and bounded attempts', async () => {
  const isolatedNamespace = `eventflow-test-${randomUUID()}`;
  const broker = new Broker({
    url: process.env.AMQP_URL,
    namespace: isolatedNamespace,
    consumer: 'booking',
    routes: saleRoutes,
  });
  let attempts = 0;
  const exhausted = { ...envelope, eventId: randomUUID() };
  try {
    await broker.open(async (event) => {
      if (event.eventId === exhausted.eventId) throw new Error('persistent database outage');
      attempts++;
      if (attempts === 1) throw new Error('temporary database outage');
    });
    await assert.rejects(
      broker.publish({ ...envelope, eventType: 'UnknownEvent.v1' }),
      /Unroutable/,
    );
    const started = Date.now();
    await broker.publish(envelope);
    await eventually(
      async () => attempts,
      (value) => value === 2,
    );
    assert.ok(Date.now() - started >= 4500);
    const connection = await connect(process.env.AMQP_URL);
    try {
      const channel = await connection.createConfirmChannel();
      channel.sendToQueue(`${isolatedNamespace}.booking`, Buffer.from(JSON.stringify(exhausted)), {
        persistent: true,
        headers: { 'x-attempt': 4 },
      });
      await channel.waitForConfirms();
      await eventually(
        () => channel.checkQueue(`${isolatedNamespace}.booking.dlq`),
        (queue) => queue.messageCount === 1,
      );
    } finally {
      await connection.close();
    }
  } finally {
    await broker.close();
    await cleanBroker(isolatedNamespace);
  }
});
