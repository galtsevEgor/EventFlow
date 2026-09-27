import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';
import { loginBuyer, publishForBooking } from './booking-setup.mjs';
import { eventually } from '../helpers/eventually.mjs';

test(
  'two browsers receive live seat, order, ticket and organizer refund updates',
  { timeout: 180000 },
  async () => {
    const stack = await fullStack({ payments: true, tickets: { MAIL_DELIVERY_DISABLED: 'true' } });
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      const buyer = await context.newPage(),
        organizer = await context.newPage(),
        orderPage = await context.newPage(),
        observer = await browser.newPage();
      const errors = [];
      for (const page of [buyer, organizer, orderPage, observer])
        page.on('pageerror', (error) => errors.push(error.message));
      const headers = await loginBuyer(buyer, stack.origin);
      const saleId = await publishForBooking(buyer, stack.origin, headers, {
        title: 'Live concert',
        layout: { rows: 2, columns: 4 },
      });

      const { organizations } = await (
        await buyer.request.get(stack.origin + '/api/v1/organizations')
      ).json();
      const organizationId = organizations[0].id;
      await loginBuyer(observer, stack.origin, 'outsider');
      for (const page of [buyer, observer]) {
        await page.goto(`${stack.origin}/events/${saleId}`);
        await expect(page.locator('[data-live="true"]')).toBeVisible({ timeout: 15000 });
      }
      const seat = observer.getByRole('button', { name: /^Ряд 1, место 1,/ });
      await expect(seat).toBeEnabled();
      const reserve = async () => {
        const response = await buyer.request.post(stack.origin + '/api/v1/orders', {
          headers: { ...headers, 'idempotency-key': randomUUID() },
          data: { saleId, seatIds: ['r1-s1'] },
        });
        assert.equal(response.status(), 201);
        return response.json();
      };
      const first = await reserve();
      let started = performance.now();
      await expect(seat).toBeDisabled({ timeout: 4000 });
      const holdMs = performance.now() - started;
      assert.equal(
        (
          await buyer.request.post(`${stack.origin}/api/v1/orders/${first.id}/cancel`, { headers })
        ).status(),
        200,
      );
      started = performance.now();
      await expect(seat).toBeEnabled({ timeout: 4000 });
      const releaseMs = performance.now() - started;
      const order = await reserve();
      const payments = await stack.startPayments();
      await payments.reconciler.stop();
      await stack.tickets.worker.stop();
      await orderPage.goto(`${stack.origin}/orders/${order.id}`);
      await expect(orderPage.locator('.order-card[data-live="true"]')).toBeVisible({
        timeout: 15000,
      });
      await organizer.goto(`${stack.origin}/organizer/?org=${organizationId}`);
      await organizer.getByRole('button', { name: 'Заказы', exact: true }).click();
      await expect(
        organizer.getByRole('region', { name: 'Заказы и возвраты' }).locator('[data-live="true"]'),
      ).toBeVisible({ timeout: 15000 });
      const created = await buyer.request.post(
        `${stack.origin}/api/v1/orders/${order.id}/payment-attempt`,
        { headers: { ...headers, 'idempotency-key': randomUUID() }, data: {} },
      );
      assert.equal(created.status(), 202);
      const { attemptId } = await created.json();
      await eventually(() => payments.processor.run(attemptId), Boolean);
      const attempt = await payments.db.paymentAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      });
      await payments.provider.confirm(attempt.providerPaymentId, 'success');
      await payments.processor.wake(attemptId);
      await eventually(() => payments.processor.run(attemptId), Boolean);
      await expect(orderPage.getByText('Заказ подтверждён', { exact: true })).toBeVisible({
        timeout: 5000,
      });
      await expect(orderPage.getByText('Готовим билеты…')).toBeVisible();
      stack.tickets.worker.start();
      await expect(orderPage.getByRole('button', { name: /^Показать QR/ })).toHaveCount(1, {
        timeout: 5000,
      });
      const row = organizer.getByRole('article', { name: `Заказ ${order.id}` });
      await expect(row).toBeVisible({ timeout: 5000 });
      const requested = await buyer.request.post(
        `${stack.origin}/api/v1/organizations/${organizationId}/events/${saleId}/orders/${order.id}/refund`,
        {
          headers: { ...headers, 'idempotency-key': randomUUID() },
          data: { reason: 'Live refund' },
        },
      );
      assert.equal(requested.status(), 202);
      await expect(orderPage.getByRole('button', { name: /^Показать QR/ })).toHaveCount(0, {
        timeout: 5000,
      });
      await expect(row.getByText('Возврат обрабатывается', { exact: true })).toBeVisible({
        timeout: 5000,
      });
      const operation = await eventually(
        () => payments.db.refundOperation.findUnique({ where: { attemptId } }),
        Boolean,
      );
      await payments.refunds.run(operation.id);
      await expect(orderPage.getByText('Возврат выполнен', { exact: true })).toBeVisible({
        timeout: 5000,
      });
      await expect(row.getByText('Оплата возвращена', { exact: true })).toBeVisible({
        timeout: 5000,
      });
      await expect(seat).toBeEnabled({ timeout: 5000 });
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ kind: 'realtime_browser_latency', holdMs, releaseMs }));
    } finally {
      await browser.close();
      await stack.close();
    }
  },
);

test(
  'browser falls back to polling while SSE is blocked and resynchronizes after reconnect',
  { timeout: 120000 },
  async () => {
    const stack = await fullStack({ booking: true });
    const browser = await chromium.launch();
    try {
      const owner = await browser.newPage(),
        observer = await browser.newPage();
      const headers = await loginBuyer(owner, stack.origin);
      const saleId = await publishForBooking(owner, stack.origin, headers, {
        title: 'Reconnect concert',
        layout: { rows: 2, columns: 4 },
      });
      await loginBuyer(observer, stack.origin, 'outsider');
      await observer.goto(`${stack.origin}/events/${saleId}`);
      await expect(observer.locator('[data-live="true"]')).toBeVisible({ timeout: 15000 });
      const path = `**/api/v1/sales/${saleId}/updates`;
      await observer.route(path, (route) => route.abort('failed'));
      await observer.reload();
      await observer.bringToFront();
      const seat = observer.getByRole('button', { name: /^Ряд 1, место 1,/ });
      await expect(seat).toBeEnabled();
      await expect(observer.locator('[data-live="false"]')).toBeVisible();
      const reserved = await owner.request.post(stack.origin + '/api/v1/orders', {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: { saleId, seatIds: ['r1-s1'] },
      });
      assert.equal(reserved.status(), 201);
      const order = await reserved.json();
      await expect(seat).toBeDisabled({ timeout: 8000 });
      assert.equal(
        (
          await owner.request.post(`${stack.origin}/api/v1/orders/${order.id}/cancel`, {
            headers,
          })
        ).status(),
        200,
      );
      await observer.unroute(path);
      await expect(observer.locator('[data-live="true"]')).toBeVisible({ timeout: 15000 });
      await expect(seat).toBeEnabled({ timeout: 3000 });
    } finally {
      await browser.close();
      await stack.close();
    }
  },
);
