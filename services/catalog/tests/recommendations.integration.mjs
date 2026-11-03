import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { catalogFixture } from './fixture.mjs';
import { publishSearchEvent } from '../../../tests/helpers/search-catalog.mjs';

test('recommendations machine reads durable changes and hydrates only current upcoming unpaused publications', async () => {
  const f = await catalogFixture();
  try {
    const live = await publishSearchEvent(f),
      pending = await publishSearchEvent(f, { confirm: false }),
      paused = await publishSearchEvent(f),
      started = await publishSearchEvent(f),
      removed = await publishSearchEvent(f);
    await f.db.publication.update({
      where: { eventId: paused.eventId },
      data: { desiredPaused: true },
    });
    await f.db.publicEvent.update({
      where: { eventId: started.eventId },
      data: { startsAt: new Date(Date.now() - 1000) },
    });
    await f.db.publicEvent.delete({ where: { eventId: removed.eventId } });
    const machine = await f.token({
      azp: 'eventflow-recommendations',
      realm_access: { roles: ['recommendations-index'] },
    });
    const route = '/internal/recommendations/hydrate',
      ids = [
        live.eventId,
        pending.eventId,
        paused.eventId,
        started.eventId,
        removed.eventId,
        randomUUID(),
      ];
    assert.equal((await f.request(route, undefined, 'POST', { ids })).status, 401);
    for (const token of [
      live.token,
      await f.token({ azp: 'eventflow-recommendations' }),
      await f.token({ azp: 'eventflow-search', realm_access: { roles: ['search-index'] } }),
    ])
      assert.equal((await f.request(route, token, 'POST', { ids })).status, 403);
    const result = await f.request(route, machine, 'POST', { ids });
    assert.equal(result.status, 200);
    assert.deepEqual(
      result.body.events.map((event) => event.id),
      [live.eventId],
    );
    assert.equal(result.body.events[0].title, live.title);
    assert.equal(result.body.events[0].organizationId, undefined);
    assert.equal(
      (await f.request(route, machine, 'POST', { ids: [live.eventId, live.eventId] })).status,
      422,
    );
    assert.equal(
      (
        await f.request(route, machine, 'POST', {
          ids: Array.from({ length: 101 }, () => randomUUID()),
        })
      ).status,
      422,
    );
    await f.db.publication.update({
      where: { eventId: paused.eventId },
      data: { desiredPaused: false, acknowledgedPaused: true },
    });
    assert.equal(
      (await f.request(route, machine, 'POST', { ids: [paused.eventId] })).body.events.length,
      0,
    );
    const feed = await f.request('/internal/search/changes', machine);
    assert.equal(feed.status, 200);
    assert.ok(feed.body.changes.length >= 4);
    assert.equal((await f.request('/internal/search/reconcile', machine, 'POST', {})).status, 200);
    const oldClient = await f.token({
      azp: 'eventflow-search',
      realm_access: { roles: ['search-index'] },
    });
    assert.equal((await f.request('/internal/search/changes', oldClient)).status, 200);
  } finally {
    await f.close();
  }
});
