import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { searchFixture } from '../helpers/search.mjs';
import { publishSearchEvent } from '../helpers/search-catalog.mjs';
import { realtimeFixture } from '../helpers/realtime.mjs';

const document = (overrides = {}) => ({
  id: randomUUID(),
  title: 'Джаз в саду',
  description: 'Музыканты выступают под звёздами.',
  city: 'Кишинёв',
  address: 'Сцена, 1',
  timeZone: 'Europe/Chisinau',
  startsAt: '2035-06-01T16:00:00.000Z',
  endsAt: '2035-06-01T18:00:00.000Z',
  localDate: '2035-06-01',
  minPriceMinor: 2500,
  currency: 'EUR',
  capacity: 100,
  coverId: null,
  ...overrides,
});
async function get(origin, query = '', path = 'events') {
  const response = await fetch(origin + '/api/v1/search/' + path + (query ? '?' + query : ''));
  return { status: response.status, body: await response.json() };
}
async function seed(fixture, app, documents) {
  const index = await fixture.engine.activeIndex();
  await app.store.apply(
    index,
    documents.map((entry, i) => ({ position: i + 1, eventId: entry.id, document: entry })),
  );
  await fixture.engine.request('/' + index + '/_refresh', 'POST');
}

test('real search understands typos, Russian word forms and accents without exposing expired or hidden documents', async (t) => {
  const fixture = await searchFixture();
  t.after(() => fixture.close());
  const app = await fixture.start();
  const jazz = document(),
    cafe = document({ title: 'Café Chișinău', description: 'Лекция о музыке.' });
  const expired = document({ endsAt: '2020-01-01T18:00:00.000Z' });
  const hidden = document();
  await seed(fixture, app, [jazz, cafe, expired, hidden]);
  await app.store.apply(await fixture.engine.activeIndex(), [
    { position: 10, eventId: hidden.id, document: null },
  ]);
  await fixture.engine.request('/' + fixture.engine.alias + '/_refresh', 'POST');
  for (const q of ['джас', 'музыкант', 'звёздами']) {
    const result = await get(app.origin, new URLSearchParams({ q, sort: 'relevance' }).toString());
    assert.equal(result.status, 200);
    assert.deepEqual(
      result.body.events.map((e) => e.id),
      [jazz.id],
      q,
    );
    assert.equal(result.body.source, 'search');
  }
  assert.equal((await get(app.origin, 'q=cafe')).body.events[0].id, cafe.id);
  assert.equal((await get(app.origin, 'q=chisinau')).body.events[0].id, cafe.id);
  assert.equal((await get(app.origin)).body.total, 2);
  assert.equal(
    (await get(app.origin, 'q=' + encodeURIComponent('* OR visible:false'))).body.total,
    0,
  );
  const suggestions = await get(app.origin, 'q=' + encodeURIComponent('Джа'), 'suggest');
  assert.deepEqual(suggestions.body.suggestions, [
    { id: jazz.id, title: jazz.title, city: jazz.city },
  ]);
  assert.ok(!JSON.stringify(suggestions.body).includes('description'));
});

test('filters, disjunctive city facets, exact totals and stable bounded pagination agree', async (t) => {
  const fixture = await searchFixture();
  t.after(() => fixture.close());
  const app = await fixture.start();
  const documents = [
    document({ title: 'Концерт первый', minPriceMinor: 1000 }),
    document({ title: 'Концерт второй', minPriceMinor: 3000 }),
    document({ title: 'Концерт третий', city: 'Бельцы', minPriceMinor: 2000 }),
    document({
      title: 'Концерт четвёртый',
      localDate: '2035-07-01',
      startsAt: '2035-07-01T16:00:00.000Z',
      endsAt: '2035-07-01T18:00:00.000Z',
      minPriceMinor: 4000,
    }),
  ];
  await seed(fixture, app, documents);
  const query = new URLSearchParams({
    q: 'Концерт',
    city: 'кишинёв',
    from: '2035-06-01',
    to: '2035-06-30',
    minPriceMinor: '1000',
    maxPriceMinor: '3500',
    sort: 'price_desc',
    pageSize: '1',
  });
  const first = (await get(app.origin, query.toString())).body;
  assert.equal(first.total, 2);
  assert.equal(first.pages, 2);
  assert.equal(first.events[0].id, documents[1].id);
  assert.deepEqual(first.facets.cities, [
    { value: 'Кишинёв', count: 2 },
    { value: 'Бельцы', count: 1 },
  ]);
  assert.deepEqual(first.facets.price, { min: 1000, max: 3000 });
  query.set('page', '2');
  assert.equal((await get(app.origin, query.toString())).body.events[0].id, documents[0].id);
  query.set('page', '3');
  const empty = (await get(app.origin, query.toString())).body;
  assert.equal(empty.total, 2);
  assert.deepEqual(empty.events, []);
  for (const invalid of [
    'page=201',
    'pageSize=49',
    'from=2035-07-01&to=2035-06-01',
    'minPriceMinor=3000&maxPriceMinor=1000',
    'q=' + 'x'.repeat(161),
    'query_string=*',
  ]) {
    assert.equal((await get(app.origin, invalid)).status, 422, invalid);
  }
  const stable = (await get(app.origin, 'pageSize=1')).body.events[0].id;
  assert.equal((await get(app.origin, 'pageSize=1')).body.events[0].id, stable);
});

test('BFF falls back to authoritative SQL with filters and recovers automatically, while maintenance stays private', async (t) => {
  const fixture = await searchFixture();
  t.after(() => fixture.close());
  const first = await publishSearchEvent(fixture.catalog, {
    title: 'Джазовый концерт',
    description: 'Сцена у реки.',
  });
  await publishSearchEvent(fixture.catalog, {
    title: 'Джазовый концерт в Бельцах',
    configuration: { city: 'Бельцы' },
  });
  await publishSearchEvent(fixture.catalog, { title: 'Скрытый джазовый концерт', confirm: false });
  const app = await fixture.start();
  const proxy = await realtimeFixture({
    SEARCH_ENABLED: 'true',
    SEARCH_URL: app.origin,
    CATALOG_URL: fixture.catalog.origin,
  });
  t.after(() => proxy.close());
  const bff = await proxy.start();
  const query = new URLSearchParams({
    q: 'Джазовый',
    city: 'Кишинёв',
    minPriceMinor: '2000',
    maxPriceMinor: '3000',
    sort: 'price_asc',
  }).toString();
  const normal = await get(bff.origin, query);
  assert.equal(normal.status, 200);
  assert.equal(normal.body.source, 'search');
  const original = app.engine.request.bind(app.engine);
  app.engine.request = async () => {
    throw new Error('Synthetic unavailable engine');
  };
  const fallback = await get(bff.origin, query);
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.source, 'catalog');
  assert.equal(fallback.body.limited, true);
  assert.deepEqual(
    fallback.body.events.map((e) => e.id),
    [first.eventId],
  );
  assert.deepEqual(fallback.body.facets, normal.body.facets);
  assert.equal((await get(bff.origin, 'q=' + encodeURIComponent('%_'))).body.total, 0);
  assert.equal((await get(bff.origin, 'page=201')).status, 422);
  app.engine.request = original;
  assert.equal((await get(bff.origin, query)).body.source, 'search');
  for (const path of [
    '/internal/search/changes',
    '/internal/search/reconcile',
    '/internal/search/reindex',
  ])
    assert.equal((await fetch(bff.origin + path)).status, 404);
});
