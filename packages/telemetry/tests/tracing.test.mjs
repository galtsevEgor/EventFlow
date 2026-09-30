import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { Telemetry, telemetryConfig, currentTraceparent, traceContext } from '../dist/index.js';

test('concurrent operations retain their parent and exported data excludes private attributes and errors', async () => {
  const exporter = new InMemorySpanExporter();
  const telemetry = new Telemetry(
    telemetryConfig('test', {
      EVENTFLOW_TELEMETRY_ENABLED: 'true',
      EVENTFLOW_TRACE_SAMPLE_RATIO: '1',
    }),
    exporter,
  );
  try {
    const parents = await Promise.all(
      [1, 2, 3].map(async (index) => {
        let captured;
        await telemetry.run('order.reserve', async (span) => {
          span.setAttribute('http.request.method', 'POST');
          span.setAttribute('authorization', 'private-token');
          span.addEvent('private-event', { secret: 'private-value' });
          span.setStatus({ code: 2, message: 'private-exception' });
          captured = currentTraceparent();
          await delay(index * 5);
          await telemetry.run('http.client', async (child) => {
            assert.equal(child.spanContext().traceId, captured.split('-')[1]);
          });
        });
        return captured;
      }),
    );
    await telemetry.flush();
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 6);
    assert.equal(new Set(parents.map((value) => value.split('-')[1])).size, 3);
    assert.ok(!JSON.stringify(spans).includes('private'));
    assert.equal(spans.filter((span) => span.parentSpanContext).length, 3);
  } finally {
    await telemetry.shutdown();
  }
});

test('disabled telemetry exports nothing and malformed parents cannot join another trace', async () => {
  const exporter = new InMemorySpanExporter();
  const disabled = new Telemetry(telemetryConfig('test', {}), exporter);
  await disabled.run('order.reserve', async () => {});
  assert.equal(exporter.getFinishedSpans().length, 0);
  const enabled = new Telemetry(
    telemetryConfig('test', {
      EVENTFLOW_TELEMETRY_ENABLED: 'true',
      EVENTFLOW_TRACE_SAMPLE_RATIO: '1',
    }),
    exporter,
  );
  try {
    await enabled.run(
      'order.reserve',
      async (span) => {
        assert.notEqual(span.spanContext().traceId, '0'.repeat(32));
      },
      {},
      traceContext(`00-${'0'.repeat(32)}-${'1'.repeat(16)}-01`),
    );
    await enabled.flush();
    assert.equal(exporter.getFinishedSpans().length, 1);
  } finally {
    await enabled.shutdown();
  }
});

test('export failure cannot change a successful business operation', async () => {
  const exporter = {
    export: (_spans, callback) => callback({ code: 1 }),
    shutdown: async () => {},
  };
  const telemetry = new Telemetry(
    telemetryConfig('test', {
      EVENTFLOW_TELEMETRY_ENABLED: 'true',
      EVENTFLOW_TRACE_SAMPLE_RATIO: '1',
    }),
    exporter,
  );
  try {
    assert.equal(await telemetry.run('order.reserve', async () => 'committed'), 'committed');
    await telemetry.flush();
  } finally {
    await telemetry.shutdown();
  }
});
