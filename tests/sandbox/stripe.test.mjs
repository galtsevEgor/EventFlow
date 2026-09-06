import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { sandboxConfiguration } from '../../scripts/stripe-sandbox-config.mjs';
import { stripeListener } from '../helpers/stripe-listener.mjs';
import { fullStack } from '../e2e/fixture.mjs';
import { loginBuyer, publishForBooking } from '../e2e/booking-setup.mjs';
import { eventually } from '../helpers/eventually.mjs';
import { ageOrder } from '../helpers/order.mjs';

const { default: Stripe } = createRequire(
  new URL('../../services/payments/package.json', import.meta.url),
)('stripe');
rmSync('work/e4/stripe-sandbox-result.json', { force: true });
const config = sandboxConfiguration(process.env);

test(
  'real Stripe sandbox: Payment Element loads, API test payment reaches the browser through signed webhooks, late success is refunded',
  { timeout: 240000 },
  async () => {
    let listener, stack, browser;
    let stage = 'webhook listener';
    try {
      listener = await stripeListener(config);
      stage = 'isolated application startup';
      stack = await fullStack({
        payments: {
          PAYMENT_PROVIDER: 'stripe',
          STRIPE_SECRET_KEY: config.secret,
          STRIPE_PUBLISHABLE_KEY: config.publishable,
          STRIPE_WEBHOOK_SECRET: listener.secret,
        },
      });
      const payments = await stack.startPayments(),
        booking = await stack.startBooking();
      const stripe = new Stripe(config.secret, {
        apiVersion: '2026-09-30.endive',
        timeout: 10000,
        maxNetworkRetries: 0,
      });
      browser = await chromium.launch();
      const page = await browser.newPage();
      stage = 'buyer login and publication';
      const headers = await loginBuyer(page, stack.origin);
      const saleId = await publishForBooking(page, stack.origin, headers);
      async function prepare(seat) {
        const reserved = await page.request.post(stack.origin + '/api/v1/orders', {
          headers: { ...headers, 'idempotency-key': randomUUID() },
          data: { saleId, seatIds: [seat] },
        });
        assert.equal(reserved.status(), 201);
        const order = await reserved.json();
        await page.goto(`${stack.origin}/orders/${order.id}`);
        await page.getByRole('button', { name: 'Перейти к оплате', exact: true }).click();
        await expect(page.getByText('Stripe sandbox · только тестовые карты')).toBeVisible({
          timeout: 30000,
        });
        await expect(page.getByRole('button', { name: /^Оплатить / })).toBeEnabled({
          timeout: 30000,
        });
        const attempt = await payments.db.paymentAttempt.findUnique({
          where: { orderId: order.id },
        });
        assert.ok(attempt.providerPaymentId);
        return { order, attempt };
      }
      async function pay(attempt) {
        // Stripe's documented test PaymentMethod avoids raw card data in server-side test code.
        const result = await stripe.paymentIntents.confirm(
          attempt.providerPaymentId,
          { payment_method: 'pm_card_visa' },
          { idempotencyKey: `eventflow:sandbox:confirm:${attempt.id}` },
        );
        assert.equal(result.livemode, false);
        assert.equal(result.status, 'succeeded');
        assert.equal(result.amount_received, attempt.amountMinor);
        return result;
      }
      stage = 'Payment Element and real test payment';
      const first = await prepare('r1-s1');
      await pay(first.attempt);
      stage = 'signed payment webhook and Booking confirmation';
      await eventually(
        () =>
          payments.db.providerWebhook.findFirst({
            where: {
              objectId: first.attempt.providerPaymentId,
              type: 'payment_intent.succeeded',
              processedAt: { not: null },
            },
          }),
        Boolean,
        45000,
      );
      await expect(
        page.getByText('Оплата принята, заказ подтверждён.', { exact: true }),
      ).toBeVisible({ timeout: 45000 });
      assert.equal(
        (await booking.db.order.findUnique({ where: { id: first.order.id } })).state,
        'CONFIRMED',
      );
      stage = 'late payment';
      const late = await prepare('r1-s2');
      await payments.reconciler.stop();
      await pay(late.attempt);
      await ageOrder(booking.db, late.order.id, new Date(Date.now() - 60000));
      await page.request.get(`${stack.origin}/api/v1/orders/${late.order.id}`);
      payments.reconciler.start();
      stage = 'automatic full refund';
      const refund = await eventually(
        () => payments.db.refundOperation.findUnique({ where: { attemptId: late.attempt.id } }),
        (value) => value?.state === 'SUCCEEDED',
        60000,
      );
      const refunded = await stripe.refunds.retrieve(refund.providerRefundId);
      assert.equal(refunded.status, 'succeeded');
      assert.equal(refunded.amount, late.attempt.amountMinor);
      assert.equal(refunded.currency, 'eur');
      assert.equal(refunded.payment_intent, late.attempt.providerPaymentId);
      const refunds = await stripe.refunds.list({
        payment_intent: late.attempt.providerPaymentId,
        limit: 10,
      });
      assert.equal(refunds.data.length, 1);
      await eventually(
        () =>
          payments.db.providerWebhook.findFirst({
            where: {
              objectId: late.attempt.providerPaymentId,
              type: { in: ['refund.created', 'refund.updated'] },
              processedAt: { not: null },
            },
          }),
        Boolean,
        45000,
      );
      await expect(
        page.getByText('Возврат выполнен. Заказ не подтверждён.', { exact: true }),
      ).toBeVisible({ timeout: 15000 });
      assert.equal(
        (await booking.db.order.findUnique({ where: { id: late.order.id } })).state,
        'EXPIRED',
      );
      listener.assertRunning();
      mkdirSync('work/e4', { recursive: true });
      writeFileSync(
        'work/e4/stripe-sandbox-result.json',
        JSON.stringify(
          {
            checkedAt: new Date().toISOString(),
            apiVersion: '2026-09-30.endive',
            livemode: false,
            payment: 'succeeded',
            booking: 'CONFIRMED',
            lateBooking: 'EXPIRED',
            refund: 'succeeded',
            refundCount: 1,
            amountMinor: refunded.amount,
            currency: 'EUR',
            paymentElement: 'loaded',
            signedWebhooks: true,
            cardEntry: 'manual browser acceptance still required',
          },
          null,
          2,
        ),
      );
    } catch {
      // SDK and browser diagnostics can include client secrets. Report the failed phase only.
      throw new Error(
        `Stripe sandbox verification failed during: ${stage}. No real-provider acceptance recorded.`,
      );
    } finally {
      await browser?.close();
      await stack?.close();
      await listener?.close();
    }
  },
);
