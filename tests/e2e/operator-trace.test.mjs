import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { Telemetry, telemetryConfig } from '../../packages/telemetry/dist/index.js';
import { readTrace } from '../helpers/traces.mjs';

test(
  'an operator trace link opens a real trace in the provisioned viewer dashboard',
  { timeout: 60000 },
  async () => {
    const telemetry = new Telemetry(
      telemetryConfig('operator-acceptance', {
        EVENTFLOW_TELEMETRY_ENABLED: 'true',
        EVENTFLOW_TRACE_SAMPLE_RATIO: '1',
        EVENTFLOW_ENVIRONMENT: 'test',
      }),
    );
    let browser, traceId;
    try {
      await telemetry.run('operator.investigation', async (span) => {
        traceId = span.spanContext().traceId;
      });
      await telemetry.flush();
      await readTrace(traceId);
      browser = await chromium.launch();
      const page = await browser.newPage();
      const query = page.waitForResponse(
        (response) =>
          response.url().includes('/api/') &&
          (response.url().includes(traceId) ||
            (response.request().postData() ?? '').includes(traceId)),
        { timeout: 20000 },
      );
      await page.goto(`http://127.0.0.1:13000/d/eventflow-trace?var-traceId=${traceId}`);
      assert.equal((await query).status(), 200);
      await expect(page.getByText('operator.investigation', { exact: false }).first()).toBeVisible({
        timeout: 15000,
      });
    } finally {
      await browser?.close();
      await telemetry.shutdown();
    }
  },
);
