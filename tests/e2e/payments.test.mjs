import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';
import { loginBuyer, publishForBooking } from './booking-setup.mjs';
import { ageOrder } from '../helpers/order.mjs';
import { eventually } from '../helpers/eventually.mjs';
import { Reserve } from '../../services/booking/dist/orders/reserve.js';

test(
  'buyer payment survives lost responses and reloads; decline, confirmation and late-refund states are truthful',
  { timeout: 180000 },
  async () => {
    const stack = await fullStack({ payments: true });
    const browser = await chromium.launch();
    const blockedStatus = Promise.withResolvers();
    const statusStarted = Promise.withResolvers();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const headers = await loginBuyer(page, stack.origin);
      const saleId = await publishForBooking(page, stack.origin, headers);
      const payments = await stack.startPayments(),
        booking = await stack.startBooking();
      async function reserve(number) {
        const result = await page.request.post(stack.origin + '/api/v1/orders', {
          headers: { ...headers, 'idempotency-key': randomUUID() },
          data: { saleId, seatIds: [`r1-s${number}`] },
        });
        assert.equal(result.status(), 201);
        return result.json();
      }
      const order = await reserve(1);
      const base = `${stack.origin}/api/v1/orders/${order.id}`;
      assert.equal(
        (await page.request.post(base + '/payment-attempt', { data: {} })).status(),
        403,
      );
      await page.goto(`${stack.origin}/orders/${order.id}`);
      await expect(
        page.getByRole('button', { name: 'Перейти к оплате', exact: true }),
      ).toBeVisible();
      const keys = [],
        attempts = [];
      // The server commits; its response and the subsequent status lookup are temporarily lost.
      await page.route('**/payment-status', async (route) => {
        if (!attempts.length) {
          statusStarted.resolve();
          await blockedStatus.promise;
        }
        return attempts.length ? route.abort('failed') : route.continue();
      });
      await page.route('**/payment-attempt', async (route) => {
        const result = await route.fetch();
        assert.equal(result.status(), 202);
        keys.push(route.request().headers()['idempotency-key']);
        attempts.push((await result.json()).attemptId);
        await route.fulfill({
          status: 503,
          json: {
            code: 'PAYMENTS_UNAVAILABLE',
            message: 'Проверяем состояние платежа.',
            requestId: randomUUID(),
            retryable: true,
          },
        });
      });
      // A background status read must not disable an idempotent user command mid-click.
      await statusStarted.promise;
      const start = page.getByRole('button', { name: 'Перейти к оплате', exact: true });
      await expect(start).toBeEnabled();
      await start.click();
      // A live refresh can fail before the mutation finishes; prove the server committed first.
      await expect.poll(() => attempts.length, { timeout: 10000 }).toBe(1);
      blockedStatus.resolve();
      await expect(
        page.getByRole('alert').filter({ hasText: 'Не удалось проверить платёж' }),
      ).toBeVisible();
      await page.unroute('**/payment-status');
      await page.unroute('**/payment-attempt');
      await page.reload();
      await expect(page.getByText('Демо-режим · без списания денег')).toBeVisible({
        timeout: 15000,
      });
      assert.equal(await payments.db.paymentAttempt.count({ where: { orderId: order.id } }), 1);
      const session = await (await page.request.get(stack.origin + '/api/v1/auth/session')).json();
      const stored = await page.evaluate(
        (key) => sessionStorage.getItem(key),
        `eventflow:payment:${session.user.sub}:${order.id}`,
      );
      assert.equal(stored, keys[0]);
      const replay = await page.request.post(base + '/payment-attempt', {
        headers: { ...headers, 'idempotency-key': stored },
        data: {},
      });
      assert.equal((await replay.json()).attemptId, attempts[0]);
      await page.getByLabel('Результат демо-платежа').selectOption('decline');
      await page.getByRole('button', { name: /^Оплатить .* в демо$/ }).click();
      await expect(
        page.getByRole('alert').filter({ hasText: 'Демо-платёж отклонён' }),
      ).toBeVisible();
      assert.equal((await booking.db.order.findUnique({ where: { id: order.id } })).state, 'HELD');
      await page.getByLabel('Результат демо-платежа').selectOption('success');
      mkdirSync('work/e4', { recursive: true });
      await page.screenshot({ path: 'work/e4/payment-desktop.png', fullPage: true });
      await page.getByRole('button', { name: /^Оплатить .* в демо$/ }).click();
      await expect
        .poll(async () => (await booking.db.order.findUnique({ where: { id: order.id } })).state, {
          timeout: 15000,
        })
        .toBe('CONFIRMED');
      await page.reload();
      await expect(
        page.getByText('Оплата принята, заказ подтверждён.', { exact: true }),
      ).toBeVisible({ timeout: 10000 });
      assert.equal(await payments.db.fakePayment.count({ where: { attemptId: attempts[0] } }), 1);
      const late = await reserve(2);
      await page.goto(
        `${stack.origin}/orders/${late.id}?payment_intent=pi_untrusted&redirect_status=succeeded&payment_intent_client_secret=synthetic`,
      );
      await expect(
        page.getByRole('button', { name: 'Перейти к оплате', exact: true }),
      ).toBeVisible();
      await expect(page).toHaveURL(`${stack.origin}/orders/${late.id}`);
      await expect(page.getByText('Заказ подтверждён', { exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Перейти к оплате', exact: true }).click();
      await expect(page.getByLabel('Результат демо-платежа')).toBeVisible({ timeout: 15000 });
      await page.getByLabel('Результат демо-платежа').selectOption('processing');
      await page.getByRole('button', { name: /^Оплатить .* в демо$/ }).click();
      await expect(
        page.getByRole('status').filter({ hasText: 'Платёж обрабатывается' }),
      ).toBeVisible({ timeout: 10000 });
      await payments.reconciler.stop();
      const attempt = await payments.db.paymentAttempt.findUnique({ where: { orderId: late.id } });
      await ageOrder(booking.db, late.id, new Date(Date.now() - 60000));
      await page.request.get(`${stack.origin}/api/v1/orders/${late.id}`);
      const rival = await new Reserve(booking.db).run('late-payment-rival', randomUUID(), {
        saleId,
        seatIds: ['r1-s2'],
      });
      assert.equal(rival.status, 201);
      await payments.provider.confirm(attempt.providerPaymentId, 'success');
      await payments.processor.wake(attempt.id);
      await eventually(() => payments.processor.run(attempt.id), Boolean);
      const refund = await eventually(
        () => payments.db.refundOperation.findUnique({ where: { attemptId: attempt.id } }),
        Boolean,
      );
      payments.provider.inject('refund', { loseResponse: true });
      await eventually(() => payments.refunds.run(refund.id), Boolean);
      assert.equal(
        (await payments.db.refundOperation.findUnique({ where: { id: refund.id } })).state,
        'UNKNOWN',
      );
      await page.reload();
      await expect(
        page.getByRole('status').filter({ hasText: 'Уточняем результат возврата' }),
      ).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: 'work/e4/refund-mobile.png', fullPage: true });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await payments.db.refundOperation.update({
        where: { id: refund.id },
        data: { nextRunAt: new Date(0) },
      });
      await eventually(() => payments.refunds.run(refund.id), Boolean);
      await page.getByRole('button', { name: 'Обновить статус оплаты', exact: true }).click();
      await expect(
        page.getByText('Возврат выполнен. Заказ не подтверждён.', { exact: true }),
      ).toBeVisible();
      assert.equal(
        (await booking.db.order.findUnique({ where: { id: late.id } })).state,
        'EXPIRED',
      );
      assert.equal(
        (await booking.db.order.findUnique({ where: { id: rival.body.id } })).state,
        'HELD',
      );
      assert.equal(await payments.db.fakeRefund.count({ where: { operationId: refund.id } }), 1);
      assert.deepEqual(errors, []);
    } finally {
      blockedStatus.resolve();
      await browser.close();
      await stack.close();
    }
  },
);
