import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { catalogFixture } from '../services/catalog/tests/fixture.mjs';
import { bookingFixture } from './helpers/booking.mjs';
import { cleanBroker } from './helpers/broker.mjs';
import { ProvisionSale } from '../services/booking/dist/provision.js';

const namespace = 'eventflow-test-' + randomUUID();
let catalog, booking, owner, base, path, id;
const configuration = () => ({
  city: 'Кишинёв',
  address: 'Улица Музыки, 12',
  timeZone: 'Europe/Chisinau',
  startsAt: '2035-06-01T16:00:00Z',
  endsAt: '2035-06-01T18:00:00Z',
  salesStartsAt: '2035-05-01T09:00:00Z',
  salesEndsAt: '2035-06-01T15:30:00Z',
  admissionStartsAt: '2035-06-01T15:00:00Z',
  admissionEndsAt: '2035-06-01T18:00:00Z',
  currency: 'EUR',
  categories: [{ id: 'standard', name: 'Партер', priceMinor: 2500 }],
  layout: {
    rows: 2,
    columns: 3,
    defaultCategoryId: 'standard',
    overrides: [{ row: 2, number: 3, categoryId: 'standard', disabled: true }],
    map: {
      version: 1,
      width: 400,
      height: 300,
      seats: Array.from({ length: 6 }, (_, i) => ({
        seatId: `r${Math.floor(i / 3) + 1}-s${(i % 3) + 1}`,
        x: 80 + (i % 3) * 40,
        y: 140 + Math.floor(i / 3) * 40,
        rotation: 0,
      })),
      features: [
        { id: 'stage', kind: 'stage', label: 'Сцена', x: 80, y: 20, width: 200, height: 60 },
      ],
    },
  },
});
before(async () => {
  catalog = await catalogFixture();
  booking = await bookingFixture(namespace);
  owner = await catalog.token();
  const org = await catalog.request('/api/v1/organizations', owner, 'POST', {
    name: 'Команда зала',
  });
  base = `/api/v1/organizations/${org.body.id}/events`;
  const draft = await catalog.request(base, owner, 'POST', {
    title: 'Концерт со схемой',
    description: 'Живая музыка в зале.',
  });
  assert.equal(draft.status, 201);
  id = draft.body.id;
  path = base + '/' + id;
});
after(async () => {
  await booking?.close();
  await catalog?.close();
  await cleanBroker(namespace);
});

test('map configuration rejects geometry and identity mutations without advancing the revision', async () => {
  for (const mutate of [
    (c) => {
      c.layout.map.seats[0].seatId = 'r3-s1';
    },
    (c) => {
      c.layout.map.seats[0].x = c.layout.map.seats[1].x;
    },
    (c) => {
      c.layout.map.seats.pop();
    },
    (c) => {
      c.layout.map.features[0].y = 140;
    },
  ]) {
    const c = configuration();
    mutate(c);
    const result = await catalog.request(path + '/configuration', owner, 'PUT', {
      revision: 0,
      configuration: c,
    });
    assert.equal(result.status, 422, JSON.stringify(result.body));
  }
  assert.equal((await catalog.request(path, owner)).body.revision, 0);
  const stranger = await catalog.token({ sub: randomUUID() });
  assert.equal(
    (
      await catalog.request(path + '/configuration', stranger, 'PUT', {
        revision: 0,
        configuration: configuration(),
      })
    ).status,
    404,
  );
});

test('publication freezes geometry, excludes disabled inventory and keeps exactly replayable snapshot hashes', async () => {
  const c = configuration();
  assert.equal(
    (
      await catalog.request(path + '/configuration', owner, 'PUT', {
        revision: 0,
        configuration: c,
      })
    ).status,
    200,
  );
  assert.deepEqual(
    (await catalog.request(path, owner)).body.configuration.layout.map,
    c.layout.map,
  );
  assert.equal(
    (
      await catalog.request(path + '/configuration', owner, 'PUT', {
        revision: 0,
        configuration: c,
      })
    ).body.code,
    'DRAFT_CHANGED',
  );
  const coverId = randomUUID();
  await catalog.db.coverAsset.create({
    data: {
      id: coverId,
      eventId: id,
      objectKey: `fixture/${coverId}.webp`,
      width: 100,
      height: 100,
      bytes: 100,
    },
  });
  await catalog.db.eventDraft.update({ where: { id }, data: { coverId } });
  assert.equal(
    (await catalog.request(path + '/publication', owner, 'POST', { revision: 1 })).status,
    201,
  );
  const publication = await catalog.db.publication.findUnique({ where: { eventId: id } });
  const envelope = (
    await catalog.db.outbox.findFirst({
      where: { envelope: { path: ['aggregateId'], equals: id } },
    })
  ).envelope;
  const provision = booking.app.get(ProvisionSale);
  await provision.handle(envelope);
  const first = await fetch(booking.origin + '/api/v1/sales/' + id).then((r) => r.json());
  assert.equal(first.seats.length, 5);
  assert.deepEqual(
    first.seatMap.seats.map((s) => s.seatId),
    first.seats.map((s) => s.seatId),
  );
  assert.deepEqual(first.seatMap.features, c.layout.map.features);
  assert.equal(
    (await booking.db.sale.findUnique({ where: { id } })).snapshotHash,
    publication.snapshotHash,
  );
  await provision.handle({ ...envelope, eventId: randomUUID() });
  assert.equal(await booking.db.seatInventory.count({ where: { saleId: id } }), 5);
  const changed = structuredClone(envelope);
  changed.eventId = randomUUID();
  changed.data.seatMap.seats[0].x = 40;
  await provision.handle(changed);
  assert.deepEqual((await booking.db.sale.findUnique({ where: { id } })).seatMap, first.seatMap);
  assert.equal(
    (
      await catalog.request(path + '/configuration', owner, 'PUT', {
        revision: 1,
        configuration: c,
      })
    ).body.code,
    'SALE_FROZEN',
  );
});
