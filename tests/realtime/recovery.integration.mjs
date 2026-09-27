import assert from 'node:assert/strict';
import test from 'node:test';
import { realtimeFixture, updatesStream } from '../helpers/realtime.mjs';
import { realtimeInvalidation } from '../../packages/event-contracts/dist/index.js';
import { eventually } from '../helpers/eventually.mjs';

test('Pub/Sub connection loss closes streams, keeps REST available and reconnects to the latest snapshot', async () => {
  const fixture = await realtimeFixture();
  let stream, reconnected;
  try {
    const replica = await fixture.start(),
      path = `/api/v1/sales/${fixture.saleId}`;
    stream = await updatesStream(replica.origin + path + '/updates');
    await stream.wait('ready');
    assert.equal((await (await fetch(replica.origin + path)).json()).revision, 0);
    replica.bus.subscriber.destroy();
    await eventually(() => stream.closed, Boolean);
    fixture.bump();
    await replica.bus.worker.broker.publish(
      realtimeInvalidation('booking', { scope: 'sale', id: fixture.saleId }),
    );
    const snapshot = await fetch(replica.origin + path);
    assert.equal(snapshot.status, 200);
    assert.equal((await snapshot.json()).revision, 1);
    await eventually(() => replica.bus.ready, Boolean);
    reconnected = await updatesStream(replica.origin + path + '/updates');
    await reconnected.wait('ready');
    assert.equal(reconnected.frames.filter((frame) => frame.kind === 'changed').length, 0);
    assert.equal((await (await fetch(replica.origin + path)).json()).revision, 1);
  } finally {
    await stream?.close();
    await reconnected?.close();
    await fixture.close();
  }
});
test('a lost session Redis connection fails closed and a restored connection rechecks the saved session', async () => {
  const fixture = await realtimeFixture();
  let stream, reconnected;
  try {
    const replica = await fixture.start(),
      owner = await fixture.session(replica),
      path = `/api/v1/orders/${fixture.orderId}`;
    stream = await updatesStream(replica.origin + path + '/updates', { cookie: owner.cookie });
    await stream.wait('ready');
    replica.store.client.destroy();
    await eventually(() => stream.closed, Boolean);
    const refused = await fetch(replica.origin + path, { headers: { cookie: owner.cookie } });
    assert.equal(refused.status, 503);
    await refused.body.cancel();
    assert.equal(replica.hub.snapshot().active, 0);
    await replica.store.client.connect();
    await eventually(() => replica.bus.ready, Boolean);
    reconnected = await updatesStream(replica.origin + path + '/updates', { cookie: owner.cookie });
    assert.equal(reconnected.response.status, 200);
    await reconnected.wait('ready');
  } finally {
    await stream?.close();
    await reconnected?.close();
    await fixture.close();
  }
});
