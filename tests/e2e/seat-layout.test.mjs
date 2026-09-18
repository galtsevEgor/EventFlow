import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';
import { loginBuyer, publishForBooking } from './booking-setup.mjs';

test(
  'a delayed 1000-seat layout stays stable and supports keyboard selection',
  { timeout: 180000 },
  async (t) => {
    const stack = await fullStack({ booking: true });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const headers = await loginBuyer(page, stack.origin);
      const id = await publishForBooking(page, stack.origin, headers, {
        title: 'Схема зала · 1000 мест',
        layout: { rows: 20, columns: 50 },
      });

      await page.addInitScript(() => {
        window.layoutShifts = [];
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) {
              window.layoutShifts.push({
                value: entry.value,
                sources: entry.sources.map(({ node }) => node?.parentElement?.className),
              });
            }
          }
        }).observe({ type: 'layout-shift', buffered: true });
      });
      let initialRender;
      for (const pattern of ['**/api/v1/auth/session', '**/api/v1/covers/*']) {
        await page.route(pattern, async (route) => {
          await initialRender?.promise;
          await route.continue();
        });
      }
      await page.route(`**/api/v1/sales/${id}`, async (route) => {
        await delay(1250);
        await route.continue();
      });

      const results = [];
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        initialRender = Promise.withResolvers();
        const title = page.getByRole('heading', { level: 1 });
        const cover = page.getByRole('img', { name: /^Афиша:/ });
        const top = () => title.evaluate((heading) => heading.getBoundingClientRect().top);
        const height = () => cover.evaluate((image) => image.getBoundingClientRect().height);
        let initialTop;
        let initialHeight;
        try {
          await page.goto(`${stack.origin}/events/${id}`, { waitUntil: 'domcontentloaded' });
          [initialTop, initialHeight] = await Promise.all([top(), height()]);
          await delay(650);
        } finally {
          initialRender.resolve();
        }
        const seats = page.getByRole('region', { name: /Схема мест/ }).getByRole('button');
        await expect(seats).toHaveCount(1000);
        await expect(seats.first()).toBeEnabled();
        await expect.poll(() => cover.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
        assert.equal(await top(), initialTop, 'The account bar moved the event heading');
        assert.equal(await height(), initialHeight, 'The cover resized after the image loaded');
        const shifts = await page.evaluate(async () => {
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          return window.layoutShifts;
        });
        results.push({
          viewport,
          score: shifts.reduce((sum, shift) => sum + shift.value, 0),
          shifts,
        });
        await seats.first().focus();
        await seats.first().press('Space');
        await expect(seats.first()).toHaveAttribute('aria-pressed', 'true');
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
        );
      }
      t.diagnostic(JSON.stringify(results));
      assert.ok(
        results.every(({ score }) => score <= 0.1),
        JSON.stringify(results),
      );
      await page.context().clearCookies();
      await page.goto(`${stack.origin}/events/${id}`);
      await expect(
        page.getByRole('link', { name: 'Войдите, чтобы забронировать места' }),
      ).toBeVisible();
    } finally {
      await browser.close();
      await stack.close();
    }
  },
);
