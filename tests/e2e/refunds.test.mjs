import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';
import { loginBuyer, publishForBooking } from './booking-setup.mjs';
import { eventually } from '../helpers/eventually.mjs';

test(
  'organizer full refund survives a lost browser response and removes buyer QR while preserving sales history',
  { timeout: 180000 },
  async () => {
    const stack = await fullStack({ payments: true, tickets: { MAIL_DELIVERY_DISABLED: 'true' } });
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      const buyer = await context.newPage(),
        organizer = await context.newPage();
      const errors = [];
      buyer.on('pageerror', (error) => errors.push(error.message));
      organizer.on('pageerror', (error) => errors.push(error.message));
      const headers = await loginBuyer(buyer, stack.origin);
      const saleId = await publishForBooking(buyer, stack.origin, headers, {
        title: 'Концерт с возвратом',
      });
      const { organizations } = await (
        await buyer.request.get(stack.origin + '/api/v1/organizations')
      ).json();
      const organizationId = organizations[0].id;
      const payments = await stack.startPayments();
      await payments.reconciler.stop();
      const reserved = await buyer.request.post(stack.origin + '/api/v1/orders', {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: { saleId, seatIds: ['r1-s1', 'r1-s2'] },
      });
      assert.equal(reserved.status(), 201);
      const order = await reserved.json();
      const created = await buyer.request.post(
        `${stack.origin}/api/v1/orders/${order.id}/payment-attempt`,
        { headers: { ...headers, 'idempotency-key': randomUUID() }, data: {} },
      );
      assert.equal(created.status(), 202);
      const { attemptId } = await created.json();
      await payments.processor.run(attemptId);
      const attempt = await payments.db.paymentAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      });
      await payments.provider.confirm(attempt.providerPaymentId, 'success');
      await payments.processor.wake(attemptId);
      await payments.processor.run(attemptId);
      await buyer.goto(`${stack.origin}/orders/${order.id}`);
      await expect(buyer.getByRole('button', { name: /^Показать QR/ })).toHaveCount(2, {
        timeout: 20000,
      });
      await buyer
        .getByRole('button', { name: /^Показать QR/ })
        .first()
        .click();
      await expect(buyer.getByRole('img', { name: 'QR для входа. Ряд 1, место 1' })).toBeVisible();

      await organizer.goto(`${stack.origin}/organizer/?org=${organizationId}`);
      await organizer.getByRole('button', { name: 'Заказы', exact: true }).click();
      const row = organizer.getByRole('article', { name: `Заказ ${order.id}` });
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: 'Оформить возврат' }).click();
      const dialog = organizer.getByRole('dialog', { name: 'Вернуть оплату заказа' });
      await expect(dialog.getByRole('button', { name: /^Вернуть 50/ })).toBeDisabled();
      await dialog.getByLabel('Причина возврата').fill('Концерт отменён');
      const refundPath = `/api/v1/organizations/${organizationId}/events/${saleId}/orders/${order.id}/refund`;
      let key;
      await organizer.route(
        `**${refundPath}`,
        async (route) => {
          key = route.request().headers()['idempotency-key'];
          const accepted = await route.fetch();
          assert.equal(accepted.status(), 202);
          await route.abort('failed');
        },
        { times: 1 },
      );
      await dialog.getByRole('button', { name: /^Вернуть 50/ }).click();
      await expect(
        dialog.getByText(
          'Ответ мог потеряться. Обновите список или повторите запрос с той же причиной.',
        ),
      ).toBeVisible();
      await organizer.keyboard.press('Escape');
      await expect(row.getByText('Возврат обрабатывается', { exact: true })).toBeVisible({
        timeout: 15000,
      });
      const refund = await eventually(
        () => payments.db.refundOperation.findUnique({ where: { attemptId } }),
        Boolean,
      );
      assert.equal(await payments.db.fakeRefund.count(), 0);
      const buyerRefund = buyer.getByRole('region', { name: 'Возврат оплаты' });
      await expect(buyerRefund.getByText('Возвращаем полную стоимость заказа')).toBeVisible({
        timeout: 15000,
      });
      await expect(buyer.getByRole('img', { name: 'QR для входа. Ряд 1, место 1' })).toHaveCount(0);
      await expect(buyer.getByRole('button', { name: /^Показать QR/ })).toHaveCount(0);
      const repeat = await organizer.request.post(stack.origin + refundPath, {
        headers: { ...headers, 'idempotency-key': key },
        data: { reason: 'Концерт отменён' },
      });
      assert.equal(repeat.status(), 202);
      assert.equal((await repeat.json()).id, refund.id);
      await organizer.reload();
      await organizer.getByRole('button', { name: 'Заказы', exact: true }).click();
      await expect(row.getByText('Возврат обрабатывается', { exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: 'Оформить возврат' })).toHaveCount(0);
      await payments.refunds.run(refund.id);
      await expect(buyerRefund.getByText('Возврат выполнен', { exact: true })).toBeVisible({
        timeout: 15000,
      });
      await expect(buyer.getByText('Оплата возвращена', { exact: true })).toBeVisible();
      await expect(row.getByText('Оплата возвращена', { exact: true })).toBeVisible({
        timeout: 15000,
      });
      await expect
        .poll(async () => {
          const report = await organizer.request.get(
            `${stack.origin}/api/v1/organizations/${organizationId}/statistics`,
          );
          return (await report.json()).totals;
        })
        .toMatchObject({
          soldSeats: 0,
          availableSeats: 32,
          confirmedOrders: 1,
          revenueMinor: 5000,
          paidMinor: 5000,
          refundedMinor: 5000,
          netMinor: 0,
        });
      assert.equal(await payments.db.fakeRefund.count({ where: { operationId: refund.id } }), 1);
      mkdirSync('work/e12', { recursive: true });
      await organizer.screenshot({ path: 'work/e12/refund-organizer-desktop.png', fullPage: true });
      await organizer.setViewportSize({ width: 390, height: 844 });
      await organizer.screenshot({ path: 'work/e12/refund-organizer-mobile.png', fullPage: true });
      await buyer.setViewportSize({ width: 390, height: 844 });
      await buyer.screenshot({ path: 'work/e12/refund-buyer-mobile.png', fullPage: true });
      for (const page of [organizer, buyer])
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await stack.close();
    }
  },
);
