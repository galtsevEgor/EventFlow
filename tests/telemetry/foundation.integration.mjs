import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Telemetry, telemetryConfig } from '../../packages/telemetry/dist/index.js';
import { eventually } from '../helpers/eventually.mjs';

test('a real OTLP exporter reaches Collector and Tempo without private values', async () => {
  const telemetry = new Telemetry(
    telemetryConfig('acceptance', {
      EVENTFLOW_TELEMETRY_ENABLED: 'true',
      EVENTFLOW_TRACE_SAMPLE_RATIO: '1',
    }),
  );
  let traceId;
  const secret = `private-${randomUUID()}`;
  try {
    await telemetry.run('acceptance.purchase', async (span) => {
      traceId = span.spanContext().traceId;
      span.setAttribute('http.request.method', 'POST');
      span.setAttribute('cookie', secret);
      span.recordException(new Error(secret));
    });
    await telemetry.flush();
    const result = await eventually(
      async () => {
        const response = await fetch(`http://127.0.0.1:13200/api/traces/${traceId}`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(2000),
        });
        if (!response.ok) {
          await response.body.cancel();
          return null;
        }
        return response.json();
      },
      Boolean,
      20000,
    );
    const body = JSON.stringify(result);
    assert.ok(body.includes('acceptance.purchase'));
    assert.ok(body.includes('http.request.method'));
    assert.ok(!body.includes(secret));
  } finally {
    await telemetry.shutdown();
  }
});

test('a nonresponding collector cannot delay a committed operation or hang shutdown', async () => {
  const server = createServer((request) => request.resume());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const telemetry = new Telemetry(
    telemetryConfig('acceptance', {
      EVENTFLOW_TELEMETRY_ENABLED: 'true',
      EVENTFLOW_TRACE_SAMPLE_RATIO: '1',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/traces`,
    }),
  );
  try {
    const started = performance.now();
    assert.equal(await telemetry.run('acceptance.purchase', async () => 'committed'), 'committed');
    assert.ok(performance.now() - started < 500);
    await telemetry.flush();
    await telemetry.shutdown();
    assert.ok(performance.now() - started < 3500);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
