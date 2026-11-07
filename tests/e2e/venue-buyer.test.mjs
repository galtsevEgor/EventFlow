import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { createGridMap } from '../../packages/seat-map/dist/index.js';
import { fullStack } from './fixture.mjs';
import { loginBuyer, publishForBooking } from './booking-setup.mjs';
import { mappedSeatPoint, webglArgs } from './venue-setup.mjs';

test(
  'buyer selects on WebGL, Booking rejects stale inventory and realtime releases the same mapped seat',
  { timeout: 180000 },
  async () => {
    const stack = await fullStack({ booking: true }),
      browser = await chromium.launch({ args: webglArgs });
    try {
      const buyer = await browser.newPage({ viewport: { width: 1280, height: 1000 } }),
        rival = await browser.newPage(),
        anonymous = await browser.newPage();
      const errors = [];
      for (const page of [buyer, rival, anonymous])
        page.on('pageerror', (error) => errors.push(error.message));
      const headers = await loginBuyer(buyer, stack.origin),
        rivalHeaders = await loginBuyer(rival, stack.origin, 'outsider');
      const map = createGridMap(2, 4);
      const id = await publishForBooking(buyer, stack.origin, headers, {
        layout: { rows: 2, columns: 4, map },
      });
      const salePath = stack.origin + '/api/v1/sales/' + id;
      const snapshot = await (await buyer.request.get(salePath)).json();
      assert.deepEqual(snapshot.seatMap, map);
      for (const page of [buyer, rival, anonymous]) await page.goto(`${stack.origin}/events/${id}`);
      await expect(anonymous.locator('canvas')).toHaveCount(1);
      await expect(
        anonymous.getByRole('link', { name: 'Войдите, чтобы забронировать места' }),
      ).toBeVisible();
      await expect(buyer.locator('[data-live="true"]')).toBeVisible();
      const canvas = buyer.locator('canvas');
      await expect(canvas).toHaveCount(1);
      const point = await mappedSeatPoint(buyer, map, 'r1-s1');
      await buyer.mouse.click(point.x, point.y);
      await expect(buyer.getByText(/Выбрано: 1 ·/)).toBeVisible();
      await buyer.route('**/api/v1/sales/' + id, (route) => route.fulfill({ json: snapshot }));
      const held = await rival.request.post(stack.origin + '/api/v1/orders', {
        headers: { ...rivalHeaders, 'idempotency-key': randomUUID() },
        data: { saleId: id, seatIds: ['r1-s1'] },
      });
      assert.equal(held.status(), 201);
      const rivalOrder = await held.json();
      await buyer.getByRole('button', { name: 'Забронировать', exact: true }).click();
      await expect(
        buyer.getByRole('alert').filter({ hasText: 'Одно из мест уже занято' }),
      ).toBeVisible();
      await buyer.unroute('**/api/v1/sales/' + id);
      await buyer.reload();
      await buyer.getByRole('button', { name: 'Список мест', exact: true }).click();
      const seat = (n) => buyer.getByRole('button', { name: new RegExp(`^Ряд 1, место ${n} ·`) });
      await expect(seat(1)).toBeDisabled();
      await expect(buyer.locator('[data-live="true"]')).toBeVisible();
      const cancelled = await rival.request.post(
        `${stack.origin}/api/v1/orders/${rivalOrder.id}/cancel`,
        { headers: rivalHeaders },
      );
      assert.equal(cancelled.status(), 200);
      await expect(seat(1)).toBeEnabled({ timeout: 4000 });
      await seat(2).focus();
      await buyer.keyboard.press('Space');
      await seat(3).click();
      await expect(buyer.getByText(/Выбрано: 2 ·/)).toBeVisible();
      await buyer.getByRole('button', { name: 'План зала', exact: true }).click();
      mkdirSync('work/e22', { recursive: true });
      await canvas.screenshot({ path: 'work/e22/buyer-map.png' });
      const response = buyer.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().endsWith('/api/v1/orders'),
      );
      await buyer.getByRole('button', { name: 'Забронировать', exact: true }).click();
      const reserved = await response;
      assert.equal(reserved.status(), 201);
      await expect(buyer).toHaveURL(/\/orders\/[a-f0-9-]{36}$/);
      const order = await (
        await buyer.request.get(stack.origin + '/api/v1/orders/' + buyer.url().split('/').at(-1))
      ).json();
      assert.deepEqual(order.items.map((item) => item.seatId).sort(), ['r1-s2', 'r1-s3']);
      assert.equal(order.totalMinor, 5000);
      await expect(
        buyer.getByRole('status').filter({ hasText: 'Места забронированы' }),
      ).toBeVisible();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await stack.close();
    }
  },
);
