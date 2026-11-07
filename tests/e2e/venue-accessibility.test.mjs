import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { createGridMap } from '../../packages/seat-map/dist/index.js';
import { fullStack } from './fixture.mjs';
import { loginBuyer, publishForBooking } from './booking-setup.mjs';
import { venueDraft, webglArgs } from './venue-setup.mjs';
import { dragVenueSeat, measureVenueEditor, pinchVenue } from './venue-measure.mjs';

test(
  '1000-seat maps support bounded rendering, repeated unmount, touch, context loss and keyboard fallback',
  { timeout: 240000 },
  async () => {
    const stack = await fullStack({ booking: true }),
      browser = await chromium.launch({ args: webglArgs });
    try {
      const context = await browser.newContext({
          hasTouch: true,
          viewport: { width: 1280, height: 1000 },
        }),
        page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const headers = await loginBuyer(page, stack.origin);
      const draft = await venueDraft(page, stack.origin, headers, {
        withMap: true,
        rows: 20,
        columns: 50,
      });
      await page.goto(`${stack.origin}/organizer/?org=${draft.organizationId}`);
      const cdp = await context.newCDPSession(page);
      const measured = await measureVenueEditor(page, cdp);
      assert.equal(measured.deliveredPointerEvents, 30);
      mkdirSync('work/e22', { recursive: true });
      writeFileSync('work/e22/venue-performance.json', JSON.stringify(measured, null, 2));
      assert.ok(
        measured.openToPaintMs < 8000,
        '1000-seat first paint exceeded the 8s budget at 4x CPU throttle',
      );
      assert.ok(measured.panP95Ms < 100, '1000-seat pan p95 exceeded 100ms at 4x CPU throttle');
      assert.ok(
        measured.heapGrowthAfterWarmupBytes < 16 * 1024 * 1024,
        'Repeated map unmounts retained over 16MiB of JS heap',
      );
      assert.equal(measured.domCanvasesAfterUnmount, 0);
      const map = createGridMap(20, 50);
      const id = await publishForBooking(page, stack.origin, headers, {
        organizationId: draft.organizationId,
        layout: { rows: 20, columns: 50, map },
      });
      const sale = await (await page.request.get(stack.origin + '/api/v1/sales/' + id)).json();
      assert.equal(sale.seats.length, 1000);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${stack.origin}/events/${id}`);
      await expect(page.locator('canvas')).toHaveCount(1);
      await page.getByRole('button', { name: 'Список мест', exact: true }).click();
      await expect(page.getByRole('button', { name: /^Ряд 1, место 1 ·/ })).toBeEnabled();
      await page.getByRole('button', { name: 'План зала', exact: true }).click();
      assert.ok(await dragVenueSeat(page, cdp, map), 'Touch drag starting on a seat must pan');
      await expect(page.getByText(/Выбрано: 0 ·/)).toBeVisible();
      await page.getByRole('button', { name: 'Показать весь зал', exact: true }).click();
      assert.ok(await pinchVenue(page, cdp), 'Two-finger pinch must change the map viewport');
      await expect(page.getByText(/Выбрано: 0 ·/)).toBeVisible();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator('canvas').screenshot({ path: 'work/e22/thousand-seat-mobile.png' });
      await page.locator('canvas').evaluate((canvas) => {
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        const extension = gl.getExtension('WEBGL_lose_context');
        if (!extension) throw new Error('Context loss extension unavailable');
        extension.loseContext();
      });
      await expect(
        page.getByRole('status').filter({ hasText: 'Графический план недоступен' }),
      ).toBeVisible();
      await expect(page.locator('canvas')).toHaveCount(0);
      const seats = page.getByRole('button', { name: /^Ряд \d+, место \d+ ·/ });
      await expect(seats).toHaveCount(50);
      for (let n = 1; n <= 6; n++)
        await page.getByRole('button', { name: new RegExp(`^Ряд 1, место ${n} ·`) }).click();
      await expect(page.getByRole('button', { name: /^Ряд 1, место 7 ·/ })).toBeDisabled();
      for (let n = 1; n <= 6; n++)
        await page.getByRole('button', { name: new RegExp(`^Ряд 1, место ${n} ·`) }).click();
      for (let i = 1; i < 20; i++)
        await page.getByRole('button', { name: 'Следующие места', exact: true }).click();
      const last = page.getByRole('button', { name: /^Ряд 20, место 50 ·/ });
      await last.focus();
      await page.keyboard.press('Space');
      await expect(last).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByText(/Выбрано: 1 ·/)).toBeVisible();
      const blocked = await browser.newContext({
        storageState: await context.storageState(),
        viewport: { width: 390, height: 844 },
      });
      await blocked.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          if (['webgl', 'webgl2', 'experimental-webgl'].includes(type)) return null;
          return original.apply(this, [type, ...args]);
        };
      });
      const fallback = await blocked.newPage();
      fallback.on('pageerror', (error) => errors.push(error.message));
      await fallback.goto(`${stack.origin}/events/${id}`);
      await expect(
        fallback.getByRole('status').filter({ hasText: 'Графический план недоступен' }),
      ).toBeVisible();
      const first = fallback.getByRole('button', { name: /^Ряд 1, место 1 ·/ });
      await expect(first).toBeEnabled();
      await first.focus();
      await fallback.keyboard.press('Space');
      await expect(first).toHaveAttribute('aria-pressed', 'true');
      await expect(fallback.locator('canvas')).toHaveCount(0);
      await fallback.screenshot({ path: 'work/e22/webgl-fallback-mobile.png' });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await stack.close();
    }
  },
);
