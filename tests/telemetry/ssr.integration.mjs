import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { fullStack } from '../e2e/fixture.mjs';
import { readTrace, traceSpans } from '../helpers/traces.mjs';
import { metricValue } from '../helpers/metrics.mjs';

test(
  'production Next SSR, BFF and Catalog appear in one trace without query values',
  { timeout: 90000 },
  async () => {
    const previous = process.env.EVENTFLOW_TELEMETRY_ENABLED;
    const previousEnvironment = process.env.EVENTFLOW_ENVIRONMENT;
    process.env.EVENTFLOW_TELEMETRY_ENABLED = 'true';
    process.env.EVENTFLOW_ENVIRONMENT = 'test';
    let stack;
    try {
      stack = await fullStack();
      const traceId = randomBytes(16).toString('hex');
      const response = await fetch(stack.origin + '/?q=private-search-value', {
        headers: { traceparent: `00-${traceId}-${randomBytes(8).toString('hex')}-01` },
      });
      assert.equal(response.status, 200);
      assert.ok((await response.text()).includes('EventFlow'));
      const body = await readTrace(traceId, (value) => {
        const services = new Set(traceSpans(value).map((span) => span.service));
        return ['storefront', 'bff', 'catalog'].every((service) => services.has(service));
      });
      assert.ok(!JSON.stringify(body).includes('private-search-value'));
      assert.ok(
        (await metricValue(
          'sum(eventflow_http_requests_total{service_name="storefront",deployment_environment_name="test",route="/"})',
        )) > 0,
      );
    } finally {
      await stack?.close();
      if (previousEnvironment === undefined) delete process.env.EVENTFLOW_ENVIRONMENT;
      else process.env.EVENTFLOW_ENVIRONMENT = previousEnvironment;
      if (previous === undefined) delete process.env.EVENTFLOW_TELEMETRY_ENABLED;
      else process.env.EVENTFLOW_TELEMETRY_ENABLED = previous;
    }
  },
);
