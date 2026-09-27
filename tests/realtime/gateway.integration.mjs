import assert from 'node:assert/strict';
import test from 'node:test';
import { createGateway } from '../../scripts/gateway.mjs';
import { realtimeFixture, updatesStream } from '../helpers/realtime.mjs';
import { eventually } from '../helpers/eventually.mjs';

test('gateway reserves a separate stream budget and closes the upstream subscription on disconnect', async () => {
  const fixture = await realtimeFixture({}, { httpConcurrency: 1 });
  let gateway, stream;
  try {
    const replica = await fixture.start();
    gateway = createGateway({
      bff: replica.origin,
      limits: { apiConcurrent: 1, streamConcurrent: 1 },
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${gateway.address().port}`;
    stream = await updatesStream(`${origin}/api/v1/sales/${fixture.saleId}/updates`);
    assert.equal(stream.response.status, 200);
    await stream.wait('ready');
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${origin}/api/v1/sales/${fixture.saleId}`);
      assert.equal(response.status, 200);
      await response.body.cancel();
    }
    const saturated = await fetch(`${origin}/api/v1/sales/${fixture.saleId}/updates`);
    assert.equal(saturated.status, 503);
    assert.equal((await saturated.json()).code, 'HTTP_BUSY');
    assert.equal((await fetch(origin + '/health/ready')).status, 200);
    await stream.close();
    await eventually(
      () => replica.hub.snapshot().active,
      (n) => n === 0,
    );
  } finally {
    await stream?.close();
    if (gateway) {
      gateway.closeAllConnections();
      await new Promise((resolve) => gateway.close(resolve));
    }
    await fixture.close();
  }
});
