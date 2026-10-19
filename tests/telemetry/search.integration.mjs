import test from 'node:test';
import assert from 'node:assert/strict';
import { currentTelemetry } from '../../packages/telemetry/dist/index.js';
import { searchFixture } from '../helpers/search.mjs';
import { publishSearchEvent } from '../helpers/search-catalog.mjs';
import { metricValue, metricQuery } from '../helpers/metrics.mjs';

test(
  'Search exports durable cursor gap and sync age to Prometheus without query or event labels',
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
    let fixture;
    try {
      fixture = await searchFixture();
      const app = await fixture.start(),
        telemetry = currentTelemetry(),
        labels = 'service_instance_id="' + telemetry.instanceId + '"';
      const event = await publishSearchEvent(fixture.catalog);
      await telemetry.flush();
      assert.equal(await metricValue('eventflow_search_cursor_gap{' + labels + '}'), 1);
      assert.equal(
        await metricValue('eventflow_search_checkpoint{' + labels + '}', (n) => n === 0),
        0,
      );
      await app.projection.sync();
      await telemetry.flush();
      assert.equal(
        await metricValue('eventflow_search_cursor_gap{' + labels + '}', (n) => n === 0),
        0,
      );
      assert.equal(await metricValue('eventflow_search_checkpoint{' + labels + '}'), 1);
      assert.equal(await metricValue('eventflow_search_ready{' + labels + '}'), 1);
      assert.ok(
        (await metricValue('eventflow_search_sync_age_seconds{' + labels + '}', (n) => n >= 0)) >=
          0,
      );
      const response = await fetch(app.origin + '/api/v1/search/events?q=private-search-query');
      assert.equal(response.status, 200);
      await response.body.cancel();
      await telemetry.flush();
      await metricValue(
        'eventflow_http_requests_total{' + labels + ',route="/api/v1/search/events"}',
      );
      const http = await metricQuery('eventflow_http_requests_total{' + labels + '}');
      assert.ok(http.some((row) => row.metric.route === '/api/v1/search/events'));
      assert.ok(!JSON.stringify(http).includes('private-search-query'));
      assert.ok(!JSON.stringify(http).includes(event.eventId));
    } finally {
      await fixture?.close();
      keys.forEach((key, i) =>
        previous[i] === undefined ? delete process.env[key] : (process.env[key] = previous[i]),
      );
    }
  },
);
