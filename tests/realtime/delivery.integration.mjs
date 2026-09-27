import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { realtimeFixture, updatesStream } from '../helpers/realtime.mjs';
import { realtimeInvalidation } from '../../packages/event-contracts/dist/index.js';
import { eventually } from '../helpers/eventually.mjs';

test('a single RabbitMQ consumer fans updates to two BFF replicas while preserving scopes', async () => {
  const fixture = await realtimeFixture();
  const streams = [];
  try {
    const first = await fixture.start(),
      second = await fixture.start();
    const path = `/api/v1/sales/${fixture.saleId}/updates`;
    streams.push(
      await updatesStream(first.origin + path),
      await updatesStream(second.origin + path),
    );
    for (const stream of streams) {
      assert.equal(stream.response.status, 200);
      assert.match(stream.response.headers.get('content-type'), /text\/event-stream/);
      await stream.wait('ready');
    }
    await first.bus.worker.broker.publish(
      realtimeInvalidation('booking', { scope: 'sale', id: randomUUID() }),
    );
    await first.bus.worker.broker.publish(
      realtimeInvalidation('booking', { scope: 'sale', id: fixture.saleId }),
    );
    for (const stream of streams) {
      await stream.wait('changed');
      assert.ok(stream.frames.every((frame) => Object.keys(frame).join() === 'kind'));
    }
    await streams[0].close();
    await eventually(
      () => first.hub.snapshot().active,
      (n) => n === 0,
    );
    const replacement = await updatesStream(first.origin + path);
    streams.push(replacement);
    await replacement.wait('ready');
    assert.equal(replacement.frames.filter((frame) => frame.kind === 'changed').length, 0);
    assert.equal((await fetch(first.origin + '/health/ready')).status, 200);
  } finally {
    for (const stream of streams) await stream.close();
    await fixture.close();
  }
});

test('private streams check ownership, current organizer access, origin and distributed connection limits', async () => {
  const fixture = await realtimeFixture();
  const streams = [];
  try {
    const first = await fixture.start(),
      second = await fixture.start();
    const owner = await fixture.session(first),
      outsider = await fixture.session(first, 'outsider'),
      manager = await fixture.session(first, 'manager');
    const path = `/api/v1/orders/${fixture.orderId}/updates`;
    assert.equal((await fetch(first.origin + path)).status, 401);
    assert.equal(
      (await fetch(first.origin + path, { headers: { cookie: outsider.cookie } })).status,
      404,
    );
    assert.equal(
      (
        await fetch(first.origin + path, {
          headers: { cookie: owner.cookie, origin: 'https://foreign.test' },
        })
      ).status,
      403,
    );
    for (const replica of [first, second]) {
      const stream = await updatesStream(replica.origin + path, { cookie: owner.cookie });
      streams.push(stream);
      assert.equal(stream.response.status, 200);
      await stream.wait('ready');
    }
    assert.equal(
      (await fetch(second.origin + path, { headers: { cookie: owner.cookie } })).status,
      429,
    );
    const organizerPath = `/api/v1/organizations/${fixture.organizationId}/events/${fixture.saleId}/orders/updates`;
    const organizer = await updatesStream(second.origin + organizerPath, {
      cookie: manager.cookie,
    });
    streams.push(organizer);
    assert.equal(organizer.response.status, 200);
    await organizer.wait('ready');
    fixture.revokeManager();
    await eventually(() => organizer.closed, Boolean);
    await first.store.destroy(owner.id);
    await eventually(() => streams.slice(0, 2).every((stream) => stream.closed), Boolean);
    await eventually(
      () => first.hub.snapshot().active + second.hub.snapshot().active,
      (n) => n === 0,
    );
    assert.equal(
      (await fetch(second.origin + path, { headers: { cookie: owner.cookie } })).status,
      401,
    );
  } finally {
    for (const stream of streams) await stream.close();
    await fixture.close();
  }
});
