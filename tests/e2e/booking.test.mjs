import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';
import { loginBuyer, publishForBooking } from './booking-setup.mjs';
import { Reserve } from '../../services/booking/dist/orders/reserve.js';
import { ageOrder } from '../helpers/order.mjs';

test(
  'buyer selects seats, recovers a lost response and reload, cancels and observes expiry with a stable timer',
  { timeout: 180000 },
  async () => {
    const stack = await fullStack({ booking: true });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const headers = await loginBuyer(page, stack.origin);
      const saleId = await publishForBooking(page, stack.origin, headers);
      const booking = await stack.startBooking();
      const reservePath = stack.origin + '/api/v1/orders';
      assert.equal(
        (await page.request.post(reservePath, { data: { saleId, seatIds: ['r1-s1'] } })).status(),
        403,
      );
      await page.goto(`${stack.origin}/events/${saleId}`);
      const seat = (n) => page.getByRole('button', { name: new RegExp(`^Ряд 1, место ${n},`) });
      await expect(seat(1)).toBeEnabled();
      for (let n = 1; n <= 6; n++) await seat(n).click();
      await expect(seat(7)).toBeDisabled();
      for (let n = 2; n <= 6; n++) await seat(n).click();
      const snapshot = await (
        await page.request.get(`${stack.origin}/api/v1/sales/${saleId}`)
      ).json();
      await page.route(`**/api/v1/sales/${saleId}`, (route) => route.fulfill({ json: snapshot }));
      const rival = await new Reserve(booking.db).run('rival', randomUUID(), {
        saleId,
        seatIds: ['r1-s1'],
      });
      assert.equal(rival.status, 201);
      await page.getByRole('button', { name: 'Забронировать', exact: true }).click();
      await expect(
        page.getByRole('alert').filter({ hasText: 'Одно из мест уже занято' }),
      ).toBeVisible();
      await page.unroute(`**/api/v1/sales/${saleId}`);
      await page.reload();
      await expect(seat(1)).toBeDisabled();
      await seat(2).click();
      await seat(3).click();
      mkdirSync('work/e3', { recursive: true });
      await page.screenshot({ path: 'work/e3/seat-selection-desktop.png', fullPage: true });
      let lostOrder;
      let attempts = 0;
      await page.route('**/api/v1/orders', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch();
        assert.equal(response.status(), 201);
        const committedId = (await response.json()).id;
        if (lostOrder) assert.equal(committedId, lostOrder);
        lostOrder = committedId;
        if (attempts++ === 0)
          await route.fulfill({
            status: 500,
            json: {
              code: 'INTERNAL_ERROR',
              message: 'Synthetic lost response after commit',
              requestId: randomUUID(),
              retryable: false,
            },
          });
        else await route.abort('failed');
      });
      await page.getByRole('button', { name: 'Забронировать', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Повторить запрос' })).toBeVisible();
      await page.getByRole('button', { name: 'Повторить запрос' }).click();
      await expect(
        page.getByRole('alert').filter({ hasText: 'Не удалось получить ответ' }),
      ).toBeVisible();
      await page.unroute('**/api/v1/orders');
      await page.reload();
      await expect(page.getByRole('link', { name: 'Открыть заказ' })).toBeVisible();
      await page.getByRole('button', { name: 'Повторить запрос' }).click();
      await expect(page).toHaveURL(`${stack.origin}/orders/${lostOrder}`);
      await expect(page.getByText('Итого: 50,00 €', { exact: true })).toBeVisible();
      const initial = await (await page.request.get(`${reservePath}/${lostOrder}`)).json();
      const seconds = (text) => text.split(':').reduce((sum, n) => sum * 60 + Number(n), 0);
      const before = seconds(await page.getByRole('timer').innerText());
      await page.clock.setFixedTime(new Date('2040-01-01T00:00:00Z'));
      const after = seconds(await page.getByRole('timer').innerText());
      assert.ok(after <= before && after >= before - 3);
      await page.reload();
      await expect(
        page.getByRole('status').filter({ hasText: 'Места забронированы' }),
      ).toBeVisible();
      const reloaded = await (await page.request.get(`${reservePath}/${lostOrder}`)).json();
      assert.equal(reloaded.expiresAt, initial.expiresAt);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: 'work/e3/order-mobile.png', fullPage: true });
      await page.getByRole('button', { name: 'Отменить бронь', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Бронь отменена' })).toBeVisible();
      await page.getByRole('link', { name: 'Вернуться к мероприятию' }).click();
      await expect(seat(2)).toBeEnabled();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      await page.screenshot({ path: 'work/e3/seat-selection-mobile.png', fullPage: true });
      await seat(2).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Забронировать', exact: true }).click();
      await expect(page).toHaveURL(/\/orders\/[a-f0-9-]+$/);
      const next = page.url().split('/').at(-1);
      await ageOrder(booking.db, next);
      await expect(page.getByRole('status').filter({ hasText: 'Срок брони истёк' })).toBeVisible({
        timeout: 10000,
      });
      await page.getByRole('link', { name: 'Все заказы', exact: true }).click();
      await expect(page.locator('.order-summary')).toHaveCount(2);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await stack.close();
    }
  },
);
