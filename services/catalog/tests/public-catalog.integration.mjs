import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { catalogFixture } from './fixture.mjs';
import { publicProjection } from '../dist/public-catalog/projection.js';

let fixture, hidden, visible;
const ids = [];
before(async () => {
  fixture = await catalogFixture();
  const org = await fixture.db.organization.create({
    data: { name: 'Catalog tests', createdBy: 'fixture' },
  });
  for (let i = 0; i < 16; i++) {
    const id = randomUUID();
    ids.push(id);
    await fixture.db.eventDraft.create({
      data: {
        id,
        organizationId: org.id,
        title: i === 15 ? '100% concert' : 'Summer concert',
        description: '<script>untrusted content</script>',
      },
    });
    await fixture.db.publicEvent.create({
      data: {
        eventId: id,
        city: i % 2 ? 'Balti' : 'Chisinau',
        address: 'Music Street 12',
        timeZone: 'Europe/Chisinau',
        startsAt: '2035-06-01T22:00:00Z',
        endsAt: '2035-06-02T01:00:00Z',
        localDate: '2035-06-02',
        minPriceMinor: 2500,
        currency: 'EUR',
        capacity: 5,
      },
    });
  }
  visible = ids[0];
  hidden = (
    await fixture.db.eventDraft.create({ data: { organizationId: org.id, title: 'Private draft' } })
  ).id;
});
after(async () => {
  await fixture?.close();
});

test('only published projections are public; response exposes safe fields and explicit cache policy', async () => {
  const response = await fixture.request(`/api/v1/events/${visible}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /public, max-age=15/);
  assert.equal(response.body.title, 'Summer concert');
  for (const field of [
    'organizationId',
    'snapshot',
    'snapshotHash',
    'objectKey',
    'publication',
    'configuration',
  ])
    assert.equal(field in response.body, false);
  const draft = await fixture.request(`/api/v1/events/${hidden}`);
  assert.equal(draft.status, 404);
  assert.equal(draft.headers.get('cache-control'), 'no-store');
  assert.equal((await fixture.request(`/api/v1/events/${randomUUID()}`)).status, 404);
  assert.equal((await fixture.request('/api/v1/events/not-a-uuid')).status, 422);
  const list = await fixture.request('/api/v1/events?pageSize=48');
  assert.deepEqual(
    list.body.events.find((event) => event.id === visible),
    response.body,
  );
});
test('search, city and local-date filters compose with deterministic pagination for tied start times', async () => {
  const first = await fixture.request('/api/v1/events?pageSize=3');
  const second = await fixture.request('/api/v1/events?pageSize=3&page=2');
  assert.equal(first.body.total, 16);
  assert.equal(first.body.pages, 6);
  assert.deepEqual(
    first.body.events.map((event) => event.id),
    ids.toSorted().slice(0, 3),
  );
  assert.deepEqual(
    second.body.events.map((event) => event.id),
    ids.toSorted().slice(3, 6),
  );
  assert.deepEqual((await fixture.request('/api/v1/events?pageSize=3')).body, first.body);
  const filtered = await fixture.request(
    '/api/v1/events?q=summer&city=chisinau&from=2035-06-02&to=2035-06-02',
  );
  assert.equal(filtered.body.total, 8);
  assert.ok(filtered.body.events.every((event) => event.city === 'Chisinau'));
  assert.equal((await fixture.request('/api/v1/events?to=2035-06-01')).body.total, 0);
  assert.equal((await fixture.request('/api/v1/events?q=%25')).body.total, 1);
  assert.equal((await fixture.request('/api/v1/events?q=missing')).body.total, 0);
  const emptyPage = await fixture.request('/api/v1/events?page=1000&pageSize=3');
  assert.deepEqual(emptyPage.body, { events: [], total: 16, page: 1000, pageSize: 3, pages: 6 });
});
test('invalid filters are rejected and past events disappear from upcoming results but retain their page', async () => {
  for (const query of [
    'page=0',
    'pageSize=1000',
    'page=oops',
    'from=2035-02-30',
    'from=2035-07-01&to=2035-06-01',
    'q=a&q=b',
    'unknown=x',
  ])
    assert.equal((await fixture.request('/api/v1/events?' + query)).status, 422, query);
  await fixture.db.publicEvent.update({
    where: { eventId: visible },
    data: {
      startsAt: '2020-01-01T10:00:00Z',
      endsAt: '2020-01-01T12:00:00Z',
      localDate: '2020-01-01',
    },
  });
  assert.equal((await fixture.request('/api/v1/events')).body.total, 15);
  assert.equal((await fixture.request(`/api/v1/events/${visible}`)).status, 200);
});
test('projection dates use event timezone and minimum price excludes disabled and unused categories', () => {
  const projection = publicProjection(randomUUID(), {
    city: 'Chisinau',
    address: 'Music Street 12',
    timeZone: 'Europe/Chisinau',
    startsAt: '2035-06-01T22:00:00Z',
    endsAt: '2035-06-02T01:00:00Z',
    salesStartsAt: '2035-05-01T10:00:00Z',
    salesEndsAt: '2035-06-01T20:00:00Z',
    admissionStartsAt: '2035-06-01T21:00:00Z',
    admissionEndsAt: '2035-06-02T01:00:00Z',
    currency: 'EUR',
    categories: [
      { id: 'regular', name: 'Regular', priceMinor: 2500 },
      { id: 'unused', name: 'Unused', priceMinor: 100 },
    ],
    layout: {
      rows: 1,
      columns: 2,
      defaultCategoryId: 'regular',
      overrides: [{ row: 1, number: 2, categoryId: 'unused', disabled: true }],
    },
  });
  assert.equal(projection.localDate, '2035-06-02');
  assert.equal(projection.capacity, 1);
  assert.equal(projection.minPriceMinor, 2500);
});
