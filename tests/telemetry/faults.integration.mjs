import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { currentTelemetry } from '../../packages/telemetry/dist/index.js';
import { realtimeInvalidation } from '../../packages/event-contracts/dist/index.js';
import { realtimeFixture, updatesStream } from '../helpers/realtime.mjs';
import { bookingFixture } from '../helpers/booking.mjs';
import { cleanBroker } from '../helpers/broker.mjs';
import { metricValue } from '../helpers/metrics.mjs';
import { eventually } from '../helpers/eventually.mjs';
import { readTrace, traceSpans } from '../helpers/traces.mjs';

function docker(...args) {
  execFileSync('docker', args, { stdio: 'pipe', windowsHide: true, timeout: 20000 });
}
async function enabled(run) {
  const keys = [
    'EVENTFLOW_TELEMETRY_ENABLED',
    'EVENTFLOW_ENVIRONMENT',
    'EVENTFLOW_TRACE_SAMPLE_RATIO',
  ];
  const previous = keys.map((key) => process.env[key]);
  Object.assign(process.env, {
    EVENTFLOW_TELEMETRY_ENABLED: 'true',
    EVENTFLOW_ENVIRONMENT: 'test',
    EVENTFLOW_TRACE_SAMPLE_RATIO: '1',
  });
  try {
    await run();
  } finally {
    keys.forEach((key, index) =>
      previous[index] === undefined
        ? delete process.env[key]
        : (process.env[key] = previous[index]),
    );
  }
}

test(
  'a stopped Collector does not block REST or committed SQL and telemetry resumes after restart',
  { timeout: 120000 },
  () =>
    enabled(async () => {
      const namespace = `eventflow-test-${randomUUID()}`;
      let realtime, booking;
      try {
        realtime = await realtimeFixture();
        const replica = await realtime.start();
        booking = await bookingFixture(namespace);
        const telemetry = currentTelemetry();
        const labels = `service_instance_id="${telemetry.instanceId}"`;
        docker('stop', '--time', '2', 'eventflow-observability-collector-1');
        const started = performance.now();
        const id = randomUUID();
        await telemetry.run('acceptance.commit', async () =>
          booking.db.outbox.create({
            data: {
              id,
              envelope: { occurredAt: new Date().toISOString() },
              availableAt: new Date(Date.now() + 3600000),
            },
          }),
        );
        for (let i = 0; i < 10; i++) {
          const response = await fetch(`${replica.origin}/api/v1/sales/${realtime.saleId}`, {
            signal: AbortSignal.timeout(2000),
          });
          assert.equal(response.status, 200);
          await response.body.cancel();
        }
        assert.ok(
          performance.now() - started < 5000,
          'Business work waited for the unavailable exporter',
        );
        await telemetry.flush();
        assert.equal(await booking.db.outbox.count({ where: { id } }), 1);
        docker('start', 'eventflow-observability-collector-1');
        await eventually(async () => {
          try {
            return (await fetch('http://127.0.0.1:13133', { signal: AbortSignal.timeout(1000) }))
              .ok;
          } catch {
            return false;
          }
        }, Boolean);
        let traceId;
        await telemetry.run('acceptance.recovered', async (span) => {
          traceId = span.spanContext().traceId;
        });
        await telemetry.flush();
        await readTrace(traceId, (body) =>
          traceSpans(body).some((span) => span.name === 'acceptance.recovered'),
        );
        assert.equal(await metricValue(`eventflow_outbox_pending{${labels}}`), 1);
      } finally {
        docker('start', 'eventflow-observability-collector-1');
        await booking?.close();
        await realtime?.close();
        await cleanBroker(namespace);
      }
    }),
);

test(
  'consumer and Redis failures are visible, recover and fan out one traced update to two BFF replicas',
  { timeout: 120000 },
  () =>
    enabled(async () => {
      const fixture = await realtimeFixture();
      let firstStream, secondStream;
      try {
        const first = await fixture.start(),
          telemetry = currentTelemetry();
        const second = await fixture.start();
        const labels = `service_instance_id="${telemetry.instanceId}"`;
        const path = `/api/v1/sales/${fixture.saleId}`;
        await first.bus.worker.stop();
        await telemetry.flush();
        assert.equal(
          await metricValue(
            `eventflow_dependency_up{${labels},component="rabbitmq"}`,
            (value) => value === 0,
          ),
          0,
        );
        assert.equal((await fetch(first.origin + path)).status, 200);
        first.bus.worker.start();
        await eventually(() => first.bus.ready, Boolean);
        await telemetry.flush();
        assert.equal(
          await metricValue(`eventflow_dependency_up{${labels},component="rabbitmq"}`),
          1,
        );
        first.store.client.destroy();
        await telemetry.flush();
        assert.equal(
          await metricValue(
            `eventflow_dependency_up{${labels},component="redis"}`,
            (value) => value === 0,
          ),
          0,
        );
        await first.store.client.connect();
        await eventually(() => first.bus.ready, Boolean);
        await telemetry.flush();
        assert.equal(await metricValue(`eventflow_dependency_up{${labels},component="redis"}`), 1);
        firstStream = await updatesStream(first.origin + path + '/updates');
        secondStream = await updatesStream(second.origin + path + '/updates');
        await Promise.all([firstStream.wait('ready'), secondStream.wait('ready')]);
        const revision = fixture.bump();
        let traceId;
        await telemetry.run('acceptance.update', async (span) => {
          traceId = span.spanContext().traceId;
          await first.bus.worker.broker.publish(
            realtimeInvalidation('booking', { scope: 'sale', id: fixture.saleId }),
          );
        });
        await Promise.all([firstStream.wait('changed'), secondStream.wait('changed')]);
        for (const [replica, stream] of [
          [first, firstStream],
          [second, secondStream],
        ]) {
          assert.equal((await (await fetch(replica.origin + path)).json()).revision, revision);
          assert.equal(stream.frames.filter((frame) => frame.kind === 'changed').length, 1);
        }
        await telemetry.flush();
        await readTrace(traceId, (body) =>
          ['messaging.send', 'messaging.process'].every((name) =>
            traceSpans(body).some((span) => span.name === name),
          ),
        );
      } finally {
        await firstStream?.close();
        await secondStream?.close();
        await fixture.close();
      }
    }),
);
