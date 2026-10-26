import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';
import { loginBuyer, publishForBooking } from './booking-setup.mjs';
test(
  'buyer joins a waitlist, receives a live offer and pays it; organizer sees private counts',
  { timeout: 300000 },
  async () => {
    const stack = await fullStack({
        booking: true,
        payments: true,
        waitlist: true,
        analytics: true,
      }),
      browser = await chromium.launch();
    try {
      const owner = await browser.newPage({ viewport: { width: 1280, height: 1000 } }),
        errors = [];
      owner.on('pageerror', (e) => errors.push(e.message));
      const headers = await loginBuyer(owner, stack.origin);
      const created = await owner.request.post(stack.origin + '/api/v1/organizations', {
        headers,
        data: { name: 'Лист ожидания E19' },
      });
      assert.equal(created.status(), 201);
      const org = (await created.json()).id;
      const id = await publishForBooking(owner, stack.origin, headers, {
        organizationId: org,
        layout: { rows: 1, columns: 1 },
      });
      const reserve = await owner.request.post(stack.origin + '/api/v1/orders', {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: { saleId: id, seatIds: ['r1-s1'] },
      });
      assert.equal(reserve.status(), 201);
      const normal = await reserve.json();
      await owner.goto(stack.origin + '/organizer/?org=' + org);
      await owner.getByRole('button', { name: 'Лист ожидания', exact: true }).click();
      await owner.getByRole('button', { name: 'Включить лист ожидания', exact: true }).click();
      await expect(owner.getByText('Лист ожидания: включён', { exact: true })).toBeVisible();
      const buyer = await browser.newPage({ viewport: { width: 390, height: 844 } });
      buyer.on('pageerror', (e) => errors.push(e.message));
      const buyerHeaders = await loginBuyer(buyer, stack.origin, 'outsider');
      assert.equal(
        (
          await buyer.request.post(stack.origin + '/api/v1/waitlist', {
            data: { saleId: id, categoryId: 'standard' },
          })
        ).status(),
        403,
      );
      await buyer.goto(stack.origin + '/events/' + id);
      await buyer.getByRole('button', { name: 'Ждать билет', exact: true }).click();
      const card = buyer.getByRole('article', { name: 'Подписка на билет' });
      await expect(card).toHaveAttribute('data-live', 'true', { timeout: 15000 });
      await expect(card.getByText('Ожидаем свободное место', { exact: true })).toBeVisible();
      const entries = await (await buyer.request.get(stack.origin + '/api/v1/waitlist')).json(),
        entry = entries.entries[0];
      assert.equal(
        (await owner.request.get(stack.origin + '/api/v1/waitlist/' + entry.id)).status(),
        404,
      );
      assert.equal(
        (
          await owner.request.get(stack.origin + '/api/v1/waitlist/' + entry.id + '/updates', {
            timeout: 5000,
          })
        ).status(),
        404,
      );
      assert.equal(
        (
          await buyer.request.post(stack.origin + '/api/v1/waitlist/' + entry.id + '/cancel', {
            headers: { ...buyerHeaders, origin: 'https://foreign.invalid' },
            data: {},
          })
        ).status(),
        403,
      );
      assert.equal(
        (
          await owner.request.post(stack.origin + '/api/v1/orders/' + normal.id + '/cancel', {
            headers,
            data: {},
          })
        ).status(),
        200,
      );
      await expect(card.getByText('Для вас есть билет', { exact: true })).toBeVisible({
        timeout: 45000,
      });
      await expect(card.getByRole('link', { name: 'Оплатить предложение' })).toBeVisible();
      const offered = await (
        await buyer.request.get(stack.origin + '/api/v1/waitlist/' + entry.id)
      ).json();
      assert.ok(offered.orderId);
      await card.getByRole('link', { name: 'Оплатить предложение' }).click();
      const payment = await buyer.request.post(
        stack.origin + '/api/v1/orders/' + offered.orderId + '/payment-attempt',
        { headers: { ...buyerHeaders, 'idempotency-key': randomUUID() }, data: {} },
      );
      assert.equal(payment.status(), 202, await payment.text());
      await expect(buyer.getByText('Демо-режим · без списания денег')).toBeVisible({
        timeout: 15000,
      });
      const paid = await buyer.request.post(
        stack.origin + '/api/v1/orders/' + offered.orderId + '/payment-attempt/fake-confirm',
        { headers: buyerHeaders, data: { outcome: 'success' } },
      );
      assert.ok([200, 202].includes(paid.status()), await paid.text());
      await buyer.goto(stack.origin + '/orders');
      await expect(
        buyer
          .getByRole('article', { name: 'Подписка на билет' })
          .getByText('Билет приобретён', { exact: true }),
      ).toBeVisible({ timeout: 45000 });
      const reportPath =
        stack.origin +
        '/api/v1/organizations/' +
        org +
        '/analytics/waitlist?from=' +
        new Date().toISOString().slice(0, 10) +
        '&to=' +
        new Date().toISOString().slice(0, 10);
      await expect
        .poll(
          async () => {
            const r = await owner.request.get(reportPath);
            return r.ok() ? (await r.json()).purchased : 0;
          },
          { timeout: 30000 },
        )
        .toBe(1);
      assert.equal((await buyer.request.get(reportPath)).status(), 403);
      assert.deepEqual(errors, []);
      assert.equal(
        await buyer.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
    } finally {
      await browser.close();
      await stack.close();
    }
  },
);
