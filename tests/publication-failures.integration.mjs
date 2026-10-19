import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { catalogFixture } from '../services/catalog/tests/fixture.mjs';
import { bookingFixture } from './helpers/booking.mjs';
import { cleanBroker } from './helpers/broker.mjs';
import { eventually } from './helpers/eventually.mjs';
import { MessageWorker } from '../packages/messaging/dist/index.js';
import { ProvisionSale } from '../services/booking/dist/provision.js';
import { PublicationConsumer } from '../services/catalog/dist/publication/consumer.js';

const namespace = `eventflow-test-${randomUUID()}`;
let catalog, booking, owner, eventId, path, original, failure, key;
before(async () => {
  catalog = await catalogFixture({ AMQP_URL: process.env.AMQP_URL, MESSAGE_NAMESPACE: namespace });
  booking = await bookingFixture(namespace);
  await booking.app.get(MessageWorker).stop();
  owner = await catalog.token();
  const org = await catalog.request('/api/v1/organizations', owner, 'POST', {
    name: 'Recovery tests',
  });
  path = `/api/v1/organizations/${org.body.id}/events`;
  const draft = await catalog.request(path, owner, 'POST', {
    title: 'Recovery concert',
    description: 'A recoverable publication.',
  });
  eventId = draft.body.id;
  path += `/${eventId}`;
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
    layout: { rows: 1, columns: 2, defaultCategoryId: 'standard', overrides: [] },
  };
  assert.equal(
    (await catalog.request(path + '/configuration', owner, 'PUT', { revision: 0, configuration }))
      .status,
    200,
  );
  const id = randomUUID();
  await catalog.db.coverAsset.create({
    data: { id, eventId, objectKey: `fixture/${id}`, width: 100, height: 100, bytes: 100 },
  });
  await catalog.db.eventDraft.update({ where: { id: eventId }, data: { coverId: id } });
});
after(async () => {
  await booking?.close();
  await catalog?.close();
  await cleanBroker(namespace);
});

test('a known provisioning conflict is durable and private without overwriting existing inventory', async () => {
  assert.equal(
    (await catalog.request(path + '/publication', owner, 'POST', { revision: 1 })).status,
    201,
  );
  original = (await catalog.db.outbox.findFirst()).envelope;
  // Simulate a conflicting legacy row inside the isolated test database.
  await new ProvisionSale(booking.db).handle({
    ...original,
    eventId: randomUUID(),
    data: {
      ...original.data,
      seats: original.data.seats.map((seat) => ({ ...seat, priceMinor: 1 })),
    },
  });
  booking.app.get(MessageWorker).start();
  const publication = await eventually(
    () => catalog.db.publication.findUnique({ where: { eventId } }),
    (item) => item.state === 'FAILED',
  );
  assert.equal(publication.failureCode, 'SNAPSHOT_CONFLICT');
  assert.equal(publication.attempt, 1);
  assert.equal(await catalog.db.publicEvent.count(), 0);
  assert.equal((await booking.db.seatInventory.findFirst()).priceMinor, 1);
  assert.equal((await catalog.request(`/api/v1/events/${eventId}`)).status, 404);
  failure = (
    await booking.db.outbox.findFirst({
      where: { envelope: { path: ['eventType'], equals: 'SaleProvisionFailed.v1' } },
    })
  ).envelope;
});
test('retry requires membership and an idempotency key, reuses the snapshot and ignores stale failures', async () => {
  await booking.app.get(MessageWorker).stop();
  assert.equal(
    (await catalog.request(path + '/publication/retry', owner, 'POST', { expectedAttempt: 1 }))
      .status,
    422,
  );
  key = randomUUID();
  const outsider = await catalog.token({ sub: randomUUID() });
  assert.equal(
    (
      await catalog.request(
        path + '/publication/retry',
        outsider,
        'POST',
        { expectedAttempt: 1 },
        { 'idempotency-key': key },
      )
    ).status,
    404,
  );
  const retry = () =>
    catalog.request(
      path + '/publication/retry',
      owner,
      'POST',
      { expectedAttempt: 1 },
      { 'idempotency-key': key },
    );
  const results = await Promise.all([retry(), retry()]);
  assert.ok(results.every((result) => result.status === 201 && result.body.attempt === 2));
  assert.equal(await catalog.db.outbox.count(), 2);
  assert.equal(await catalog.db.publicationRetry.count(), 1);
  const publications = (await catalog.db.outbox.findMany()).map((item) => item.envelope);
  assert.deepEqual(publications[0].data, publications[1].data);
  assert.equal(
    (
      await catalog.request(
        path + '/publication/retry',
        owner,
        'POST',
        { expectedAttempt: 2 },
        { 'idempotency-key': key },
      )
    ).status,
    409,
  );
  await new PublicationConsumer(catalog.db).handle({ ...failure, eventId: randomUUID() });
  assert.equal(
    (await catalog.db.publication.findUnique({ where: { eventId } })).state,
    'PROVISIONING',
  );
  // Remove only the deliberately corrupted fixture, then process the retained request.
  await booking.db.seatInventory.deleteMany({ where: { saleId: eventId } });
  await booking.db.sale.delete({ where: { id: eventId } });
  booking.app.get(MessageWorker).start();
  await eventually(
    () => catalog.db.publication.findUnique({ where: { eventId } }),
    (item) => item.state === 'PUBLISHED',
  );
  assert.equal(await booking.db.seatInventory.count(), 2);
  assert.equal((await booking.db.seatInventory.findFirst()).priceMinor, 2500);
  assert.equal((await retry()).status, 201);
  assert.equal(await catalog.db.outbox.count(), 3);
  assert.equal(
    await catalog.db.outbox.count({
      where: { envelope: { path: ['eventType'], equals: 'SaleProvisionRequested.v1' } },
    }),
    2,
  );
  assert.equal(
    await catalog.db.outbox.count({
      where: { envelope: { path: ['eventType'], equals: 'SearchDocumentChanged.v1' } },
    }),
    1,
  );
  const current = await catalog.db.publication.findUnique({ where: { eventId } });
  await new PublicationConsumer(catalog.db).handle({
    ...failure,
    eventId: randomUUID(),
    causationId: current.requestId,
  });
  assert.equal(
    (await catalog.db.publication.findUnique({ where: { eventId } })).state,
    'PUBLISHED',
  );
  assert.equal(await catalog.db.publicEvent.count(), 1);
});
test('invalid sale invariants produce a safe failure receipt and no partial inventory', async () => {
  const request = {
    ...original,
    eventId: randomUUID(),
    aggregateId: randomUUID(),
    data: { ...original.data, admissionEndsAt: '2035-06-01T15:30:00Z' },
  };
  await new ProvisionSale(booking.db).handle(request);
  assert.equal(await booking.db.sale.count({ where: { id: request.aggregateId } }), 0);
  assert.equal(await booking.db.seatInventory.count({ where: { saleId: request.aggregateId } }), 0);
  const receipt = await booking.db.outbox.findFirst({
    where: { envelope: { path: ['causationId'], equals: request.eventId } },
  });
  assert.equal(receipt.envelope.eventType, 'SaleProvisionFailed.v1');
  assert.equal(receipt.envelope.data.code, 'INVALID_SNAPSHOT');
});
