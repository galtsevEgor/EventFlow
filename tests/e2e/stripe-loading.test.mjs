import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';

test(
  'a blocked Stripe script shows a recoverable message instead of an indefinitely empty form',
  { timeout: 90000 },
  async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    const child = spawn(
      process.execPath,
      [
        'node_modules/next/dist/bin/next',
        'start',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      {
        cwd: 'apps/storefront',
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    child.stdout.resume();
    child.stderr.resume();
    const closed = new Promise((resolve) => child.once('close', resolve));
    const origin = `http://127.0.0.1:${port}`;
    let browser;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error('Storefront stopped before readiness');
        try {
          const response = await fetch(origin, { signal: AbortSignal.timeout(1000) });
          await response.body?.cancel();
          if (response.ok) break;
        } catch {
          // The server has not finished starting yet.
        }
        if (attempt === 99) throw new Error('Storefront did not start');
        await delay(200);
      }
      browser = await chromium.launch();
      const page = await browser.newPage();
      await page.clock.install();
      const orderId = randomUUID(),
        attemptId = randomUUID(),
        saleId = randomUUID(),
        now = new Date();
      const order = {
        id: orderId,
        saleId,
        title: 'Тестовое событие',
        currency: 'EUR',
        totalMinor: 2500,
        state: 'HELD',
        createdAt: now.toISOString(),
        serverNow: now.toISOString(),
        expiresAt: new Date(+now + 600000).toISOString(),
        items: [{ seatId: 'r1-s1', categoryName: 'Стандарт', row: 1, number: 1, priceMinor: 2500 }],
      };
      const payment = {
        attemptId,
        orderId,
        provider: 'stripe',
        state: 'REQUIRES_ACTION',
        bookingState: 'PENDING',
        amountMinor: 2500,
        currency: 'EUR',
        refundState: null,
        reviewCode: null,
        canPay: true,
        clientSecret: 'pi_synthetic_secret_synthetic',
        publishableKey: 'pk_test_synthetic',
      };
      await page.route('**/api/v1/auth/session', (route) =>
        route.fulfill({
          json: {
            user: {
              sub: 'synthetic-buyer',
              email: 'buyer@example.test',
              emailVerified: true,
              name: 'Buyer',
            },
            csrfToken: 'synthetic-csrf',
          },
        }),
      );
      await page.route('**/api/v1/orders/**', (route) =>
        route.fulfill({
          json: route.request().url().endsWith('/payment-status') ? payment : order,
        }),
      );
      await page.route('https://js.stripe.com/**', (route) => route.abort('failed'));
      await page.goto(`${origin}/orders/${orderId}`);
      await expect(page.getByText('Stripe sandbox · только тестовые карты')).toBeVisible();
      await page.clock.fastForward(16000);
      await expect(
        page.getByRole('alert').filter({ hasText: 'Форма Stripe не загрузилась' }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Обновить страницу' })).toBeEnabled();
      await expect(page.getByRole('button', { name: /^Оплатить / })).toBeDisabled();
      assert.equal(await page.getByText('Заказ подтверждён', { exact: true }).count(), 0);
    } finally {
      await browser?.close();
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    }
  },
);
