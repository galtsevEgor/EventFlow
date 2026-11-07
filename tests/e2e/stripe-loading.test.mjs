import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';

test(
  'a blocked Stripe script shows a recoverable message instead of an indefinitely empty form',
  { timeout: 90000 },
  async () => {
    const child = spawn(
      process.execPath,
      ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '0'],
      {
        cwd: 'apps/storefront',
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let output = '',
      spawnError;
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        output = (output + chunk).slice(-4000);
      });
    child.once('error', (error) => {
      spawnError = error;
    });
    const closed = new Promise((resolve) => child.once('close', resolve));
    let browser,
      origin,
      ready = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (spawnError) throw new Error('Could not start Storefront', { cause: spawnError });
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(
            `Storefront stopped before readiness (${child.exitCode ?? child.signalCode}): ${output}`,
          );
        // Next binds port 0 itself; avoid releasing a reserved port before the child binds.
        origin ??= output.match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+)/)?.[1];
        try {
          if (origin) {
            const response = await fetch(origin + '/orders', { signal: AbortSignal.timeout(1000) });
            await response.body?.cancel();
            if (response.ok) {
              ready = true;
              break;
            }
          }
        } catch {
          // The server has not finished starting yet.
        }
        await delay(200);
      }
      assert.ok(ready && origin, `Storefront did not become ready: ${output}`);
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
