import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { searchEngineFixture } from '../helpers/opensearch.mjs';
import { searchFixture } from '../helpers/search.mjs';
import { publishSearchEvent } from '../helpers/search-catalog.mjs';
import { eventually } from '../helpers/eventually.mjs';
import { IndexStore } from '../../services/search/dist/index-store.js';
import { ProjectionBusy } from '../../services/search/dist/lease.js';

const document = (id) => ({
  id,
  title: 'Джаз в саду',
  description: 'Живая музыка',
  city: 'Кишинёв',
  address: 'Музыки, 1',
  timeZone: 'Europe/Chisinau',
  startsAt: '2035-06-01T16:00:00.000Z',
  endsAt: '2035-06-01T18:00:00.000Z',
  localDate: '2035-06-01',
  minPriceMinor: 2500,
  currency: 'EUR',
  capacity: 10,
  coverId: null,
});
const readDoc = (engine, index, id) => engine.request('/' + index + '/_doc/' + id);

test('external versions replay once, reject conflicting equal versions and retain tombstones against old delivery', async () => {
  const f = searchEngineFixture();
  try {
    const index = await f.engine.ensure(),
      store = new IndexStore(f.engine),
      id = randomUUID();
    const change = { eventId: id, position: 5, document: document(id) };
    await store.apply(index, [change]);
    const first = await readDoc(f.engine, index, id);
    await store.apply(index, [change, { ...change, position: 4 }]);
    assert.equal((await readDoc(f.engine, index, id))._source.indexedAt, first._source.indexedAt);
    await assert.rejects(
      store.apply(index, [
        { ...change, document: { ...change.document, title: 'Conflicting data' } },
      ]),
      /Conflicting/,
    );
    await store.apply(index, [{ eventId: id, position: 6, document: null }]);
    await store.apply(index, [change]);
    const tombstone = await readDoc(f.engine, index, id);
    assert.equal(tombstone._source.visible, false);
    assert.equal(tombstone._version, 6);
  } finally {
    await f.close();
  }
});

test('a fresh Search instance repairs missed notifications from the contiguous Catalog feed', async () => {
  const f = await searchFixture();
  try {
    const event = await publishSearchEvent(f.catalog),
      first = await f.start();
    let index = await first.engine.activeIndex();
    assert.equal((await readDoc(first.engine, index, event.eventId))._source.title, event.title);
    await f.catalog.request(event.path, event.token, 'PATCH', {
      title: event.title,
      description: 'Missed notification',
    });
    await first.app.close();
    const second = await f.start();
    index = await second.engine.activeIndex();
    assert.equal(
      (await readDoc(second.engine, index, event.eventId))._source.description,
      'Missed notification',
    );
    assert.equal((await second.store.checkpoint(index)).position, 2);
  } finally {
    await f.close();
  }
});

test('a lost bulk response cannot advance the checkpoint and exact replay finishes without another document version', async () => {
  const f = await searchFixture();
  try {
    const app = await f.start(),
      event = await publishSearchEvent(f.catalog),
      index = await app.engine.activeIndex();
    const original = app.engine.request.bind(app.engine);
    let lost = false;
    app.engine.request = async (...args) => {
      const response = await original(...args);
      if (!lost && args[0].endsWith('/_bulk')) {
        lost = true;
        throw new Error('Lost bulk response');
      }
      return response;
    };
    await assert.rejects(app.projection.sync(), /Lost bulk response/);
    assert.equal((await app.store.checkpoint(index)).position, 0);
    assert.equal((await readDoc(app.engine, index, event.eventId))._version, 1);
    app.engine.request = original;
    await app.projection.sync();
    assert.equal((await app.store.checkpoint(index)).position, 1);
    assert.equal((await readDoc(app.engine, index, event.eventId))._version, 1);
  } finally {
    await f.close();
  }
});

test('a writer that loses its lease during a feed read cannot write or remove its successor lease', async () => {
  const f = await searchFixture();
  let release, stale;
  try {
    const a = await f.start(),
      b = await f.start();
    const index = await a.engine.activeIndex();
    const checkpoint = await a.store.checkpoint(index);
    const event = await publishSearchEvent(f.catalog);
    const key = f.namespace + ':writer';
    let entered;
    const ready = new Promise((resolve) => {
        entered = resolve;
      }),
      gate = new Promise((resolve) => {
        release = resolve;
      });
    const read = a.projection.feed.read.bind(a.projection.feed);
    a.projection.feed.read = async (...args) => {
      const page = await read(...args);
      entered();
      await gate;
      return page;
    };
    stale = a.projection.sync();
    await Promise.race([
      ready,
      stale.then(() => assert.fail('Expected the writer to wait on the feed')),
    ]);
    const original = await a.lease.client.get(key);
    assert.ok(original);
    const ttl = await a.lease.client.pTTL(key);
    assert.ok(ttl > 25_000 && ttl <= 30_000);
    await assert.rejects(
      b.lease.run(async () => {}),
      ProjectionBusy,
    );
    await a.lease.client.pExpire(key, 1);
    await eventually(
      () => a.lease.client.get(key),
      (value) => value === null,
    );
    await b.lease.run(async (lease) => {
      const successor = await b.lease.client.get(key);
      assert.ok(successor && successor !== original);
      await b.lease.client.pExpire(key, 15_000);
      await lease.assert();
      const renewed = await b.lease.client.pTTL(key);
      assert.ok(renewed > 25_000 && renewed <= 30_000);
      release();
      await assert.rejects(stale, ProjectionBusy);
      assert.equal(await b.lease.client.get(key), successor);
      await assert.rejects(
        readDoc(a.engine, index, event.eventId),
        (error) => error.status === 404,
      );
      assert.deepEqual(await a.store.checkpoint(index), checkpoint);
    });
    await b.projection.sync();
    assert.equal((await readDoc(b.engine, index, event.eventId))._source.title, event.title);
  } finally {
    release?.();
    await stale?.catch(() => {});
    await f.close();
  }
});

test('losing an active index resets its checkpoint even when its concrete name is reused', async () => {
  const f = await searchFixture();
  try {
    const event = await publishSearchEvent(f.catalog),
      app = await f.start();
    const index = await app.engine.activeIndex(),
      generation = await app.engine.identity(index);
    assert.equal((await app.store.checkpoint(index)).position, 1);
    assert.ok(index.startsWith(f.namespace + '-'));
    await app.engine.request('/' + index, 'DELETE');
    await assert.rejects(app.projection.sync(), (error) => error.status === 404);
    await app.projection.sync();
    assert.notEqual(await app.engine.identity(index), generation);
    assert.equal((await readDoc(app.engine, index, event.eventId))._source.title, event.title);
    assert.equal((await app.store.checkpoint(index)).complete, true);
  } finally {
    await f.close();
  }
});

test(
  'real RabbitMQ delivers the committed publication to competing Search workers even with feed polling stopped',
  { timeout: 120000 },
  async () => {
    const f = await searchFixture({ rabbit: true });
    try {
      const first = await f.start({ workers: true }),
        second = await f.start({ workers: true });
      await first.worker.stop();
      await second.worker.stop();
      const event = await publishSearchEvent(f.catalog);
      const index = await first.engine.activeIndex();
      const saved = await eventually(
        async () => {
          try {
            return await readDoc(first.engine, index, event.eventId);
          } catch {
            return null;
          }
        },
        Boolean,
        30000,
      );
      assert.equal(saved._version, 1);
      assert.equal(saved._source.title, event.title);
      assert.equal((await first.store.checkpoint(index)).position, 0);
      await first.app.close();
      await second.app.close();
      const restarted = await f.start({ workers: true });
      await eventually(
        () => restarted.store.checkpoint(index),
        (value) => value.position === 1,
      );
      assert.equal((await readDoc(restarted.engine, index, event.eventId))._version, 1);
    } finally {
      await f.close();
    }
  },
);
