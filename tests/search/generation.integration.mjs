import test from 'node:test';
import assert from 'node:assert/strict';
import { searchFixture } from '../helpers/search.mjs';
import { publishSearchEvent } from '../helpers/search-catalog.mjs';

test('a late checkpoint retains its captured generation and cannot mark a recreated empty index as complete', async (t) => {
  const fixture = await searchFixture();
  t.after(() => fixture.close());
  const event = await publishSearchEvent(fixture.catalog),
    app = await fixture.start(),
    index = await app.engine.activeIndex();
  const old = await app.store.checkpoint(index);
  await app.engine.request('/' + index, 'DELETE');
  await app.engine.ensure();
  const generation = await app.engine.identity(index);
  assert.notEqual(generation, old.generation);
  // Simulate an expired owner resuming between its last lease assertion and checkpoint write.
  await app.store.save(index, old.position, old.complete, old.generation);
  const checkpoint = await app.store.checkpoint(index);
  assert.equal(checkpoint.position, 0);
  assert.equal(checkpoint.complete, false);
  await assert.rejects(app.store.ready());
  await app.projection.sync();
  const document = await app.engine.request('/' + index + '/_doc/' + event.eventId);
  assert.equal(document._source.title, event.title);
  const repaired = await app.store.checkpoint(index);
  assert.equal(repaired.generation, generation);
  assert.equal(repaired.position, old.position);
  assert.equal(repaired.complete, true);
});
