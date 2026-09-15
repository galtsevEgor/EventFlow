import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { kubectl, kubeOutput } from '../../scripts/cluster/local.mjs';
import { loginBuyer, publishForBooking } from '../e2e/booking-setup.mjs';

const origin = 'http://127.0.0.1:58000';
const deployment = 'deployment/storefront';
const title = 'Схема зала · 1000 мест';
assert.equal(kubeOutput(['get', 'hpa', '-o', 'name']), '', 'Use a fixed cluster profile');
const original = kubeOutput(['get', deployment, '-o', 'jsonpath={.spec.replicas}']);

function scale(replicas) {
  kubectl(['scale', deployment, '--replicas=' + replicas]);
  kubectl(['rollout', 'status', deployment, '--timeout=2m']);
}

const browser = await chromium.launch();
try {
  const setup = await browser.newPage();
  const headers = await loginBuyer(setup, origin, 'owner', 'work/e7/credentials/demo-users.json');
  const event = await publishForBooking(setup, origin, headers, {
    title,
    layout: { rows: 20, columns: 50 },
  });
  const session = await setup.context().storageState();
  await setup.close();
  const results = [];
  for (const replicas of [1, 2]) {
    scale(replicas);
    const context = await browser.newContext({
      storageState: session,
      viewport: { width: 1280, height: 800 },
    });
    try {
      await context.addInitScript(() => {
        const metrics = (window.eventflowLab = { lcpMs: 0, layoutShift: 0, maxInteractionMs: 0 });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) metrics.lcpMs = entry.startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            if (!entry.hadRecentInput) metrics.layoutShift += entry.value;
        }).observe({ type: 'layout-shift', buffered: true });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.interactionId)
              metrics.maxInteractionMs = Math.max(metrics.maxInteractionMs, entry.duration);
          }
        }).observe({ type: 'event', durationThreshold: 16, buffered: true });
      });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      const measureCatalog = async () => {
        assert.equal((await page.goto(origin)).status(), 200);
        await page.waitForFunction(() => window.eventflowLab.lcpMs > 0);
        return page.evaluate(() => ({
          ...window.eventflowLab,
          ttfbMs: performance.getEntriesByType('navigation')[0].responseStart,
        }));
      };
      const cold = await measureCatalog();
      const warm = await measureCatalog();
      const link = page.getByRole('link', { name: new RegExp(title) }).first();
      if (!(await link.count())) throw new Error('Published event is absent from the catalog');
      await link.click();
      await page.waitForURL(origin + '/events/' + event);
      const seats = page.getByRole('region', { name: /Схема мест/ }).getByRole('button');
      await expect(seats).toHaveCount(1000);
      await expect(seats.first()).toBeEnabled();
      await seats.first().click();
      await expect(seats.first()).toHaveAttribute('aria-pressed', 'true');
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const map = await page.evaluate(() => window.eventflowLab);
      results.push({ replicas, cold, warm, seatCount: await seats.count(), seatMap: map });
    } finally {
      await context.close();
    }
  }
  writeFileSync(
    'work/e7/load/browser.json',
    JSON.stringify({ browser: browser.version(), cpuThrottle: 4, results }, null, 2),
  );
  console.log(
    'Cold and warm catalog plus interactive 1000-seat map verified with one and two SSR replicas',
  );
} finally {
  await browser.close();
  scale(original);
}
