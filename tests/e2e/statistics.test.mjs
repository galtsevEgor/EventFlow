import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';
import { loginBuyer, publishForBooking } from './booking-setup.mjs';
import { eventually } from '../helpers/eventually.mjs';

test(
  'organizer statistics follow real payments and completed refunds through RabbitMQ with usable filters and recovery',
  { timeout: 180000 },
  async () => {
    const stack = await fullStack({ payments: true });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const headers = await loginBuyer(page, stack.origin);
      const saleId = await publishForBooking(page, stack.origin, headers, {
        title: 'Статистика концерта',
      });
      const orgs = await (await page.request.get(stack.origin + '/api/v1/organizations')).json();
      const organizationId = orgs.organizations[0].id;
      const emptySale = await publishForBooking(page, stack.origin, headers, {
        organizationId,
        title: 'Без продаж',
      });
      const payments = await stack.startPayments();
      await payments.reconciler.stop();
      const reportUrl = `${stack.origin}/api/v1/organizations/${organizationId}/statistics`;
      const report = async () => {
        const response = await page.request.get(reportUrl);
        assert.equal(response.status(), 200);
        assert.equal(response.headers()['cache-control'], 'no-store');
        return response.json();
      };
      async function createPayment(seatIds) {
        const reserved = await page.request.post(stack.origin + '/api/v1/orders', {
          headers: { ...headers, 'idempotency-key': randomUUID() },
          data: { saleId, seatIds },
        });
        assert.equal(reserved.status(), 201);
        const order = await reserved.json();
        const created = await page.request.post(
          `${stack.origin}/api/v1/orders/${order.id}/payment-attempt`,
          {
            headers: { ...headers, 'idempotency-key': randomUUID() },
            data: {},
          },
        );
        assert.equal(created.status(), 202);
        const { attemptId } = await created.json();
        await payments.processor.run(attemptId);
        const attempt = await payments.db.paymentAttempt.findUnique({ where: { id: attemptId } });
        assert.ok(attempt.providerPaymentId);
        await payments.provider.confirm(attempt.providerPaymentId, 'success');
        return { order, attemptId };
      }
      const confirmed = await createPayment(['r1-s1', 'r1-s2']);
      await payments.processor.wake(confirmed.attemptId);
      await payments.processor.run(confirmed.attemptId);
      await expect
        .poll(async () => (await report()).totals.revenueMinor, { timeout: 15000 })
        .toBe(5000);
      const late = await createPayment(['r1-s3']);
      const cancelled = await page.request.post(
        `${stack.origin}/api/v1/orders/${late.order.id}/cancel`,
        { headers },
      );
      assert.equal(cancelled.status(), 200);
      await payments.processor.wake(late.attemptId);
      await payments.processor.run(late.attemptId);
      const refund = await eventually(
        () => payments.db.refundOperation.findUnique({ where: { attemptId: late.attemptId } }),
        Boolean,
      );
      await expect
        .poll(async () => (await report()).totals.paidMinor, { timeout: 15000 })
        .toBe(7500);
      assert.equal(
        (await report()).totals.refundedMinor,
        0,
        'Pending refunds are not completed money',
      );
      await payments.refunds.run(refund.id);
      await expect
        .poll(async () => (await report()).totals.refundedMinor, { timeout: 15000 })
        .toBe(2500);

      await page.goto(`${stack.origin}/organizer/?org=${organizationId}`);
      await page.getByRole('button', { name: 'Статистика', exact: true }).click();
      const metric = (label) =>
        page
          .locator('.sales-metrics > div')
          .filter({ has: page.getByText(label, { exact: true }) })
          .locator('dd');
      await expect(metric('Подтверждённые заказы')).toHaveText('1');
      await expect(metric('Продано мест за всё время')).toHaveText('2');
      await expect(metric('Подтверждённые продажи')).toContainText('50,00');
      await expect(metric('Получено оплат')).toContainText('75,00');
      await expect(metric('Завершённые возвраты')).toContainText('25,00');
      await expect(metric('Оплаты за вычетом возвратов')).toContainText('50,00');
      await expect(
        page.getByRole('img', { name: 'Сумма подтверждённых продаж по дням' }),
      ).toBeVisible();
      await page.getByText('Данные графика', { exact: true }).click();
      await expect(
        page.getByRole('table', { name: 'Подтверждённые продажи по дням' }),
      ).toBeVisible();
      mkdirSync('work/e10', { recursive: true });
      await page.screenshot({ path: 'work/e10/statistics-desktop.png', fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: 'work/e10/statistics-mobile.png', fullPage: true });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.getByLabel('Мероприятие', { exact: true }).selectOption(emptySale);
      await page.getByRole('button', { name: 'Применить фильтры' }).click();
      await expect(metric('Подтверждённые заказы')).toHaveText('0');
      await expect(page.getByText('В этом периоде нет подтверждённых продаж.')).toBeVisible();
      await page.getByLabel('Мероприятие', { exact: true }).selectOption(saleId);
      await page.getByRole('button', { name: 'Применить фильтры' }).click();
      await expect(metric('Подтверждённые заказы')).toHaveText('1');
      await page.route('**/statistics?*', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'UNAVAILABLE',
            message: 'Временный сбой отчёта',
            retryable: true,
          }),
        }),
      );
      await page.getByRole('button', { name: 'Обновить статистику' }).click();
      await expect(page.getByRole('alert')).toContainText('Временный сбой отчёта');
      await expect(page.locator('.sales-metrics')).toHaveCount(0);
      await page.unroute('**/statistics?*');
      await page.getByRole('button', { name: 'Обновить статистику' }).click();
      await expect(metric('Подтверждённые заказы')).toHaveText('1');
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await stack.close();
    }
  },
);
