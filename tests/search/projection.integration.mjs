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

test('an expired writer cannot acknowledge work or remove the successor replica lease', async () => {
  const f = await searchFixture();
  let release;
  try {
    const a = await f.start(),
      b = await f.start();
    let entered;
    const ready = new Promise((resolve) => {
        entered = resolve;
      }),
      gate = new Promise((resolve) => {
        release = resolve;
      });
    const old = a.lease.run(async (lease) => {
      entered();
      await gate;
      await lease.assert();
    });
    await ready;
    await assert.rejects(
      b.lease.run(async () => {}),
      ProjectionBusy,
    );
    await a.lease.client.del(f.namespace + ':writer');
    await b.lease.run(async (lease) => {
      release();
      await assert.rejects(old, ProjectionBusy);
      assert.ok(await b.lease.client.get(f.namespace + ':writer'));
      await lease.assert();
    });
  } finally {
    release?.();
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
