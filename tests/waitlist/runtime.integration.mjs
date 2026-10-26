import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { waitlistFixture } from '../helpers/waitlist.mjs';
import { eventually } from '../helpers/eventually.mjs';
import { TemporalRuntime } from '../../services/waitlist/dist/runtime.js';
import { readWaitlistConfig } from '../../services/waitlist/dist/config.js';
const require = createRequire(new URL('../../services/waitlist/package.json', import.meta.url));
const { Connection, Client } = require('@temporalio/client');
test('Temporal outage preserves joins and a recovered worker dispatches the durable revision', async () => {
  const f = await waitlistFixture();
  let runtime, connection;
  try {
    const entry = await f.join('durable');
    const config = readWaitlistConfig({
      ...process.env,
      MESSAGE_NAMESPACE: f.namespace,
      WAITLIST_DATABASE_URL: f.databaseUrl,
    });
    const offline = new TemporalRuntime(
      { ...config, TEMPORAL_ADDRESS: '127.0.0.1:1' },
      f.db,
      f.coordinator,
    );
    await offline.tick();
    await offline.onModuleDestroy();
    assert.equal((await f.queue.read('durable', entry.id)).state, 'WAITING');
    assert.equal(await f.booking.db.order.count(), 0);
    const [pending] = await f.db.query(
      'SELECT revision,delivered FROM workflow_dispatch WHERE sale_id=$1',
      f.sale.id,
    );
    assert.ok(BigInt(pending.revision) > BigInt(pending.delivered));
    runtime = new TemporalRuntime(config, f.db, f.coordinator);
    await runtime.tick();
    runtime.onApplicationBootstrap();
    const offered = await eventually(
      () => f.queue.read('durable', entry.id),
      (r) => r.state === 'OFFERED',
      30000,
    );
    assert.ok(offered.orderId);
    await runtime.status();
    await f.queue.cancel('durable', entry.id);
    await runtime.tick();
    await eventually(
      () => f.queue.read('durable', entry.id),
      (r) => r.state === 'CANCELLED',
      30000,
    );
    assert.equal(await f.booking.db.order.count(), 1);
  } finally {
    await runtime?.onModuleDestroy();
    connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS });
    const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE });
    await client.workflow
      .getHandle('waitlist:' + f.namespace + ':' + f.sale.id)
      .terminate('Fixture cleanup')
      .catch(() => {});
    await connection.close();
    await f.close();
  }
});
