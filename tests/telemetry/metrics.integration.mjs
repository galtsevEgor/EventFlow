import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { currentTelemetry } from '../../packages/telemetry/dist/index.js';
import { realtimeFixture, updatesStream } from '../helpers/realtime.mjs';
import { bookingFixture } from '../helpers/booking.mjs';
import { cleanBroker } from '../helpers/broker.mjs';
import { metricQuery, metricValue } from '../helpers/metrics.mjs';
import { eventually } from '../helpers/eventually.mjs';

test(
  'real HTTP, SSE, dependency and SQL metrics reach Prometheus without private labels',
  { timeout: 120000 },
  async () => {
    const keys = [
      'EVENTFLOW_TELEMETRY_ENABLED',
      'EVENTFLOW_ENVIRONMENT',
      'EVENTFLOW_TRACE_SAMPLE_RATIO',
    ];
    const previous = keys.map((key) => process.env[key]);
    Object.assign(process.env, {
      EVENTFLOW_TELEMETRY_ENABLED: 'true',
      EVENTFLOW_ENVIRONMENT: 'test',
      EVENTFLOW_TRACE_SAMPLE_RATIO: '0',
    });
    const namespace = `eventflow-test-${randomUUID()}`;
    let realtime, booking, stream;
    try {
      realtime = await realtimeFixture();
      const replica = await realtime.start();
      const telemetry = currentTelemetry();
      const labels = `service_instance_id="${telemetry.instanceId}"`;
      const response = await fetch(
        `${replica.origin}/api/v1/sales/${realtime.saleId}?q=private-metric-query`,
      );
      assert.equal(response.status, 200);
      await response.body.cancel();
      stream = await updatesStream(`${replica.origin}/api/v1/sales/${realtime.saleId}/updates`);
      await stream.wait('ready');
      await telemetry.flush();
      assert.equal(await metricValue(`eventflow_sse_active{${labels}}`), 1);
      assert.equal(await metricValue(`eventflow_dependency_up{${labels},component="redis"}`), 1);
      await stream.close();
      await eventually(
        () => replica.hub.snapshot().active,
        (n) => n === 0,
      );
      await telemetry.flush();
      assert.equal(await metricValue(`eventflow_sse_active{${labels}}`, (n) => n === 0), 0);
      assert.equal(await metricValue(`eventflow_sse_events_total{${labels},kind="closed"}`), 1);
      const http = await metricQuery(`eventflow_http_requests_total{${labels}}`);
      assert.ok(http.some((row) => row.metric.route === '/api/v1/sales/:id'));
      assert.ok(!JSON.stringify(http).includes('private-metric-query'));
      assert.ok(!JSON.stringify(http).includes(realtime.saleId));

      booking = await bookingFixture(namespace);
      const bookingTelemetry = currentTelemetry();
      const bookingLabels = `service_instance_id="${bookingTelemetry.instanceId}"`;
      await booking.db.outbox.create({
        data: {
          id: randomUUID(),
          envelope: { occurredAt: new Date(Date.now() - 60000).toISOString() },
          availableAt: new Date(Date.now() + 3600000),
        },
      });
      await bookingTelemetry.flush();
      assert.equal(await metricValue(`eventflow_outbox_pending{${bookingLabels}}`), 1);
      assert.ok(
        (await metricValue(`eventflow_outbox_oldest_seconds{${bookingLabels}}`, (n) => n >= 60)) >=
          60,
      );
      assert.equal(
        await metricValue(`eventflow_dependency_up{${bookingLabels},component="database"}`),
        1,
      );
      assert.ok((await metricValue(`eventflow_db_queries_total{${bookingLabels}}`)) > 0);
      assert.ok(
        (await metricValue(`eventflow_db_pool_connections{${bookingLabels},state="total"}`)) > 0,
      );
      assert.ok(
        (await metricValue(`eventflow_http_request_duration_seconds_count{${labels}}`)) > 0,
      );
    } finally {
      await stream?.close();
      await booking?.close();
      await realtime?.close();
      await cleanBroker(namespace);
      keys.forEach((key, index) =>
        previous[index] === undefined
          ? delete process.env[key]
          : (process.env[key] = previous[index]),
      );
    }
  },
);
