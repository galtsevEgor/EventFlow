import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { SpanKind } from '@opentelemetry/api';
import { AggregationTemporality, InMemoryMetricExporter } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { Telemetry, telemetryConfig } from '../dist/index.js';

const config = () =>
  telemetryConfig('booking', {
    EVENTFLOW_TELEMETRY_ENABLED: 'true',
    EVENTFLOW_TRACE_SAMPLE_RATIO: '0',
    EVENTFLOW_ENVIRONMENT: 'test',
  });
const metrics = (exporter) =>
  exporter.getMetrics().flatMap((frame) => frame.scopeMetrics.flatMap((scope) => scope.metrics));

test('unsampled SSR records HTTP metrics without exporting its trace', async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const spans = new InMemorySpanExporter();
  const telemetry = new Telemetry(
    { ...config(), service: 'storefront' },
    { traces: spans, metrics: exporter },
  );
  try {
    await telemetry.run('SSR', async () => {}, {
      kind: SpanKind.SERVER,
      attributes: { 'http.route': '/events/[id]', 'http.status_code': 200 },
    });
    await telemetry.flush();
    const requests = metrics(exporter).find(
      (metric) => metric.descriptor.name === 'eventflow_http_requests',
    );
    assert.equal(requests.dataPoints[0].value, 1);
    assert.equal(spans.getFinishedSpans().length, 0);
  } finally {
    await telemetry.shutdown();
  }
});

test('unsampled requests still produce metrics with seconds buckets, normalized routes and bounded series', async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const spans = new InMemorySpanExporter();
  const telemetry = new Telemetry(config(), { traces: spans, metrics: exporter });
  try {
    await telemetry.run('test.request', async () => {
      for (let index = 0; index < 400; index++)
        telemetry.metrics.http('GET', `/orders/${randomUUID()}`, 200, 0.01);
      telemetry.metrics.http('PURGE', '/orders?email=private-email', 500, 0.25);
      for (let index = 0; index < 400; index++)
        telemetry.metrics.http('GET', `/synthetic-route-${index}`, 200, 0.02);
    });
    await telemetry.flush();
    const values = metrics(exporter);
    const requests = values.find((metric) => metric.descriptor.name === 'eventflow_http_requests');
    assert.equal(
      requests.dataPoints.find((point) => point.attributes.route === '/orders/:id').value,
      400,
    );
    assert.equal(
      requests.dataPoints.find((point) => point.attributes.route === 'unmatched').attributes.method,
      'OTHER',
    );
    assert.ok(requests.dataPoints.length <= 257);
    assert.equal(
      requests.dataPoints.reduce((sum, point) => sum + point.value, 0),
      801,
    );
    assert.ok(!JSON.stringify(values).includes('private-email'));
    const histogram = values.find(
      (metric) => metric.descriptor.name === 'eventflow_http_request_duration',
    );
    assert.ok(histogram.dataPoints[0].value.buckets.boundaries.includes(0.01));
    assert.equal(spans.getFinishedSpans().length, 0);
  } finally {
    await telemetry.shutdown();
  }
});

test('snapshot batches collect once, omit private labels and isolate collection failures', async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const telemetry = new Telemetry(config(), {
    traces: new InMemorySpanExporter(),
    metrics: exporter,
  });
  let calls = 0;
  try {
    const remove = telemetry.metrics.supply(
      ['eventflow_outbox_pending', 'eventflow_outbox_oldest_seconds'],
      async () => {
        calls++;
        return [
          {
            name: 'eventflow_outbox_pending',
            value: 3,
            attributes: { private: 'private-database-value' },
          },
          { name: 'eventflow_outbox_oldest_seconds', value: 12 },
        ];
      },
    );
    const removeFailed = telemetry.metrics.supply(['eventflow_mail_pending'], () => {
      throw new Error('private-database-error');
    });
    await telemetry.flush();
    assert.equal(calls, 1);
    const values = metrics(exporter);
    assert.ok(!JSON.stringify(values).includes('private'));
    assert.equal(
      values.find((metric) => metric.descriptor.name === 'eventflow_outbox_pending').dataPoints[0]
        .value,
      3,
    );
    assert.equal(
      values.find((metric) => metric.descriptor.name === 'eventflow_metric_collection_errors')
        .dataPoints[0].value,
      1,
    );
    remove();
    removeFailed();
    await telemetry.flush();
    assert.equal(calls, 1);
  } finally {
    await telemetry.shutdown();
  }
});
