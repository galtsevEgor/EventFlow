import test from 'node:test';
import assert from 'node:assert/strict';
import { searchFixture } from '../helpers/search.mjs';
import { publishSearchEvent } from '../helpers/search-catalog.mjs';
import { RebuildIndex } from '../../services/search/dist/rebuild.js';
import { CatalogFeed } from '../../services/search/dist/catalog-feed.js';

async function edit(fixture, event, description) {
  const response = await fixture.catalog.request(event.path, event.token, 'PATCH', {
    title: event.title,
    description,
  });
  assert.equal(response.status, 200);
}
function barrier() {
  let entered, release;
  return {
    ready: new Promise((resolve) => {
      entered = resolve;
    }),
    gate: new Promise((resolve) => {
      release = resolve;
    }),
    entered: () => entered(),
    release: () => release(),
  };
}
async function text(app, id, field = 'description') {
  const document = await app.engine.request('/' + (await app.engine.activeIndex()) + '/_doc/' + id);
  return document._source[field];
}

test('rebuild keeps the active index serving and catches already acknowledged live changes before atomic cutover', async (t) => {
  const fixture = await searchFixture();
  t.after(() => fixture.close());
  const event = await publishSearchEvent(fixture.catalog),
    app = await fixture.start();
  const old = await app.engine.activeIndex(),
    feed = app.app.get(CatalogFeed),
    original = feed.read.bind(feed);
  const gate = barrier();
  feed.read = async (after, through) => {
    const page = await original(after, through);
    if (after === 0 && through === 1) {
      gate.entered();
      await gate.gate;
    }
    return page;
  };
  const rebuilding = app.app.get(RebuildIndex).run();
  try {
    await gate.ready;
    assert.equal(await app.engine.activeIndex(), old);
    assert.equal((await fetch(app.origin + '/api/v1/search/events')).status, 200);
    await edit(fixture, event, 'Джаз после начала перестроения');
    const notification = await fixture.catalog.db.outbox.findFirstOrThrow({
      where: { envelope: { path: ['eventType'], equals: 'SearchDocumentChanged.v1' } },
      orderBy: { availableAt: 'desc' },
    });
    await app.projection.project(notification.envelope);
    assert.equal(await text(app, event.eventId), 'Джаз после начала перестроения');
    gate.release();
    const rebuilt = await rebuilding;
    assert.notEqual(rebuilt.index, old);
    assert.equal(rebuilt.previousIndex, old);
    assert.equal(rebuilt.position, 2);
    assert.equal(await text(app, event.eventId), 'Джаз после начала перестроения');
    assert.equal((await app.store.checkpoint(rebuilt.index)).complete, true);
    const visible = await (
      await fetch(app.origin + '/api/v1/search/events?q=' + encodeURIComponent('перестроения'))
    ).json();
    assert.equal(visible.events[0].id, event.eventId);
  } finally {
    gate.release();
    await rebuilding.catch(() => {});
  }
});

test('failure before alias switch leaves the old generation and checkpoint intact and removes only the private candidate', async (t) => {
  const fixture = await searchFixture();
  t.after(() => fixture.close());
  const event = await publishSearchEvent(fixture.catalog),
    app = await fixture.start();
  const previous = await app.engine.activeIndex(),
    checkpoint = await app.store.checkpoint(previous),
    original = app.engine.request.bind(app.engine);
  let candidate;
  app.engine.request = async (...args) => {
    if (args[0] === '/_aliases' && args[2]?.actions?.[0]?.remove) {
      candidate = args[2].actions[1].add.index;
      throw new Error('Before cutover failure');
    }
    return original(...args);
  };
  await assert.rejects(app.app.get(RebuildIndex).run(), /Before cutover/);
  app.engine.request = original;
  assert.equal(await app.engine.activeIndex(), previous);
  assert.deepEqual(await app.store.checkpoint(previous), checkpoint);
  assert.equal(await text(app, event.eventId, 'title'), event.title);
  await assert.rejects(app.engine.request('/' + candidate), (error) => error.status === 404);
});

test('a lost alias response is repaired by a new instance from actual alias identity and durable source changes', async (t) => {
  const fixture = await searchFixture();
  t.after(() => fixture.close());
  const event = await publishSearchEvent(fixture.catalog),
    app = await fixture.start();
  const previous = await app.engine.activeIndex(),
    original = app.engine.request.bind(app.engine);
  await edit(fixture, event, 'Восстановленный концерт');
  app.engine.request = async (...args) => {
    const result = await original(...args);
    if (args[0] === '/_aliases' && args[2]?.actions?.[0]?.remove)
      throw new Error('Lost alias response');
    return result;
  };
  await assert.rejects(app.app.get(RebuildIndex).run(), /Lost alias/);
  app.engine.request = original;
  const active = await app.engine.activeIndex();
  assert.notEqual(active, previous);
  assert.equal((await app.store.checkpoint(active)).complete, false);
  assert.equal((await fetch(app.origin + '/api/v1/search/events')).status, 503);
  await app.app.close();
  const replacement = await fixture.start();
  assert.equal(await replacement.engine.activeIndex(), active);
  assert.equal((await replacement.store.checkpoint(active)).position, 2);
  assert.equal(await text(replacement, event.eventId), 'Восстановленный концерт');
  assert.equal((await fetch(replacement.origin + '/api/v1/search/events')).status, 200);
});

test('machine authorization and a distributed builder lease protect maintenance; source reconciliation retains deletion tombstones', async (t) => {
  const fixture = await searchFixture();
  t.after(() => fixture.close());
  const event = await publishSearchEvent(fixture.catalog),
    app = await fixture.start();
  const request = async (token, body = {}) =>
    fetch(app.origin + '/internal/search/reindex', {
      method: 'POST',
      headers: {
        ...(token && { authorization: 'Bearer ' + token }),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  assert.equal((await request()).status, 401);
  assert.equal(
    (await request(await fixture.catalog.token({ aud: 'eventflow-search' }))).status,
    403,
  );
  assert.equal((await request(await fixture.token(), { index: 'unrelated-index' })).status, 422);
  await app.lease.run(async () => {
    assert.equal((await request(await fixture.token())).status, 409);
  }, 'rebuild');
  await fixture.catalog.db.publicEvent.delete({ where: { eventId: event.eventId } });
  const rebuilt = await request(await fixture.token());
  assert.equal(rebuilt.status, 200);
  const response = await rebuilt.json();
  assert.equal(response.position, 2);
  const tombstone = await app.engine.request('/' + response.index + '/_doc/' + event.eventId);
  assert.equal(tombstone._source.visible, false);
  assert.equal(tombstone._version, 2);
  const old = await fixture.catalog.db.searchChange.findFirst({ orderBy: { position: 'asc' } });
  await app.store.apply(response.index, [
    { position: Number(old.position), eventId: event.eventId, document: old.document },
  ]);
  assert.equal(
    (await app.engine.request('/' + response.index + '/_doc/' + event.eventId))._source.visible,
    false,
  );
});
