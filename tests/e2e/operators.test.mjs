import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';
import { loginBuyer, publishForBooking } from './booking-setup.mjs';
import { ageOrder } from '../helpers/order.mjs';
import { eventually } from '../helpers/eventually.mjs';

test(
  'operator roles, partial sources and recovery survive a lost response and a browser reload',
  { timeout: 180000 },
  async () => {
    const stack = await fullStack({ payments: true });
    const browser = await chromium.launch();
    try {
      const buyer = await browser.newPage();
      const headers = await loginBuyer(buyer, stack.origin);
      const saleId = await publishForBooking(buyer, stack.origin, headers);
      const payments = await stack.startPayments();
      const booking = await stack.startBooking();
      await payments.reconciler.stop();
      const held = await buyer.request.post(stack.origin + '/api/v1/orders', {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: { saleId, seatIds: ['r1-s1'] },
      });
      assert.equal(held.status(), 201);
      const order = await held.json();
      const created = await buyer.request.post(
        `${stack.origin}/api/v1/orders/${order.id}/payment-attempt`,
        {
          headers: { ...headers, 'idempotency-key': randomUUID() },
          data: {},
        },
      );
      assert.equal(created.status(), 202);
      const { attemptId } = await created.json();
      await payments.processor.run(attemptId);
      const attempt = await payments.db.paymentAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      });
      await payments.provider.confirm(attempt.providerPaymentId, 'success');
      await ageOrder(booking.db, order.id);
      await payments.processor.wake(attemptId);
      await payments.processor.run(attemptId);
      const refund = await eventually(
        () => payments.db.refundOperation.findUnique({ where: { attemptId } }),
        Boolean,
      );
      payments.provider.inject('refund', { loseResponse: true });
      await payments.refunds.run(refund.id);
      await payments.db.refundOperation.update({
        where: { id: refund.id },
        data: { state: 'REQUIRES_REVIEW', reviewCode: 'RETRY_LIMIT' },
      });

      const path = `/organizer/ops?source=payments&kind=refund&id=${refund.id}`;
      await buyer.goto(stack.origin + path);
      await expect(buyer.getByText('Нет доступа к кабинету оператора.')).toBeVisible();
      await expect(buyer.getByRole('link', { name: 'Кабинет оператора', exact: true })).toHaveCount(
        0,
      );
      const viewer = await browser.newPage();
      await loginBuyer(viewer, stack.origin, 'ops-viewer');
      await viewer.goto(stack.origin + path);
      await expect(viewer.getByText('Только просмотр', { exact: true })).toBeVisible();
      await expect(
        viewer
          .getByRole('region', { name: 'Карточка расследования' })
          .getByText('Нужна проверка', { exact: true }),
      ).toBeVisible();
      await expect(viewer.getByRole('button', { name: 'Запустить восстановление' })).toHaveCount(0);

      const operator = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
      const errors = [];
      operator.on('pageerror', (error) => errors.push(error.message));
      await loginBuyer(operator, stack.origin, 'operator');
      const session = await (
        await operator.request.get(stack.origin + '/api/v1/auth/session')
      ).json();
      await operator.goto(stack.origin + '/organizer/ops');
      const sources = operator.getByRole('region', { name: 'Проблемы обработки' });
      await expect(
        sources.getByRole('button', { name: /Доставка билетов.*Источник недоступен/ }),
      ).toBeVisible();
      await operator.getByLabel('ID заказа').fill(order.id);
      await operator.getByRole('button', { name: 'Применить фильтры' }).click();
      await operator.getByRole('link', { name: 'Открыть', exact: true }).click();
      const launch = operator.getByRole('button', {
        name: 'Запустить восстановление',
        exact: true,
      });
      await launch.click();
      await expect(operator.getByRole('dialog')).toBeVisible();
      await operator.keyboard.press('Escape');
      await expect(launch).toBeFocused();
      await launch.click();
      const dialog = operator.getByRole('dialog');
      const submit = dialog.getByRole('button', { name: 'Подтвердить запуск' });
      await expect(submit).toBeDisabled();
      const reason = 'Провайдер восстановлен, требуется сверка результата';
      await dialog.getByLabel('Причина восстановления').fill(reason);
      await expect(submit).toBeDisabled();
      await dialog.getByRole('checkbox').check();
      let key;
      const lostReply = new Promise((resolve) => {
        void operator.route(
          `**/api/v1/ops/issues/payments/refund/${refund.id}/recover`,
          async (route) => {
            key = route.request().headers()['idempotency-key'];
            const accepted = await route.fetch();
            assert.equal(accepted.status(), 202);
            await route.abort('failed');
            resolve();
          },
          { times: 1 },
        );
      });
      await submit.click();
      await lostReply;
      await operator.reload();
      await expect(
        operator.getByText('Запрос принят. Ожидаем результат обработки.', { exact: true }),
      ).toBeVisible();
      const audit = await payments.db.operatorAction.findUniqueOrThrow({ where: { key } });
      assert.equal(audit.actor, session.user.sub);
      assert.equal(audit.actorType, 'HUMAN');
      assert.equal(audit.reason, reason);
      assert.equal(await payments.db.operatorAction.count(), 1);
      assert.equal(await payments.db.fakeRefund.count({ where: { operationId: refund.id } }), 1);
      await payments.refunds.run(refund.id);
      await expect(operator.getByText('Выполнено', { exact: true })).toBeVisible({
        timeout: 15000,
      });
      await expect(operator.getByText(reason, { exact: true })).toBeVisible();
      await expect(
        operator.getByRole('button', { name: 'Запустить восстановление', exact: true }),
      ).toHaveCount(0);
      assert.equal(await payments.db.fakeRefund.count({ where: { operationId: refund.id } }), 1);
      assert.equal(await payments.db.operatorAction.count(), 1);
      mkdirSync('work/e15', { recursive: true });
      await operator.screenshot({ path: 'work/e15/operator-desktop.png', fullPage: true });
      await operator.setViewportSize({ width: 390, height: 844 });
      await operator.screenshot({ path: 'work/e15/operator-mobile.png', fullPage: true });
      assert.equal(
        await operator.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await operator.goto(stack.origin + '/organizer/ops');
      await operator.screenshot({ path: 'work/e15/operator-list-mobile.png', fullPage: true });
      assert.equal(
        await operator.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await stack.close();
    }
  },
);
