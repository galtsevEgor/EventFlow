import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { loginBuyer, publishForBooking } from './booking-setup.mjs';
import { fullStack } from './fixture.mjs';
import { eventually } from '../helpers/eventually.mjs';
import { findMail, receivedMail, smtpProxy } from '../helpers/mailpit.mjs';
import { ClientCredentials } from '../../packages/service-runtime/dist/index.js';
import { MessageWorker } from '../../packages/messaging/dist/index.js';

async function readQr(response) {
  assert.equal(response.status(), 200);
  assert.equal(response.headers()['content-type'], 'image/png');
  assert.equal(response.headers()['cache-control'], 'no-store');
  assert.equal(response.headers()['cross-origin-resource-policy'], 'same-origin');
  const png = PNG.sync.read(await response.body());
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.ok(decoded && /^[A-Za-z0-9_-]{32}$/.test(decoded.data), 'QR must carry an opaque code');
  return decoded.data;
}

test(
  'a verified buyer gets a private, scannable QR for each seat once Booking confirms the order',
  { timeout: 120000 },
  async () => {
    const smtp = await smtpProxy();
    let browser, stack;
    try {
      stack = await fullStack({ payments: true, tickets: { MAILPIT_SMTP_PORT: smtp.port } });
      await stack.tickets.worker.stop();
      const payments = await stack.startPayments();
      await payments.reconciler.stop();
      await payments.app.get(MessageWorker).stop();
      browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const headers = await loginBuyer(page, stack.origin);
      const saleId = await publishForBooking(page, stack.origin, headers);
      const reservation = await page.request.post(stack.origin + '/api/v1/orders', {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: { saleId, seatIds: ['r1-s2', 'r1-s1'] },
      });
      assert.equal(reservation.status(), 201);
      const order = await reservation.json();
      const pageUrl = `${stack.origin}/orders/${order.id}`;
      const listUrl = `${stack.origin}/api/v1/orders/${order.id}/tickets`;
      assert.equal((await page.request.get(listUrl)).status(), 404);
      await page.goto(pageUrl);
      await expect(page.getByRole('heading', { name: 'Билеты', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Перейти к оплате', exact: true }).click();
      await expect(page.getByText('Подготавливаем оплату и проверяем бронь…')).toBeVisible();
      const attempt = await eventually(
        () => payments.db.paymentAttempt.findUnique({ where: { orderId: order.id } }),
        Boolean,
      );
      // Keep the stream open but delay Payments events: REST must recover the CREATED snapshot.
      await expect(page.locator('.order-card')).toHaveAttribute('data-live', 'true');
      await payments.processor.run(attempt.id);
      await expect(page.getByRole('button', { name: /^Оплатить .* в демо$/ })).toBeVisible({
        timeout: 10000,
      });
      payments.app.get(MessageWorker).start();
      payments.reconciler.start();
      await page.getByRole('button', { name: /^Оплатить .* в демо$/ }).click();
      await expect(page.getByText('Готовим билеты…')).toBeVisible({ timeout: 20000 });
      assert.equal(await stack.tickets.db.ticket.count(), 0);
      await expect(page.getByText('Кишинёв, Улица Музыки, 12')).toBeVisible();

      stack.tickets.worker.start();
      const panel = page.getByRole('region', { name: 'Билеты' });
      const show = panel.getByRole('button', { name: /^Показать QR/ });
      await expect(show).toHaveCount(2, { timeout: 20000 });
      await expect(panel).toHaveCount(1);
      await expect(page.getByRole('region', { name: 'Оплата заказа' })).toHaveCount(1);
      await expect(panel.getByRole('heading', { level: 3 })).toHaveText([
        'Ряд 1, место 1',
        'Ряд 1, место 2',
      ]);
      const list = await page.request.get(listUrl);
      assert.equal(list.status(), 200);
      assert.equal(list.headers()['cache-control'], 'no-store');
      const { tickets } = await list.json();
      assert.deepEqual(
        tickets.map((ticket) => Object.keys(ticket).sort()),
        [
          ['categoryName', 'id', 'number', 'row'],
          ['categoryName', 'id', 'number', 'row'],
        ],
      );
      const qrUrl = `${listUrl}/${tickets[0].id}/qr`;
      const qrResponse = page.waitForResponse(qrUrl);
      await show.first().click();
      const credential = await readQr(await qrResponse);
      const image = panel.getByRole('img', { name: 'QR для входа. Ряд 1, место 1' });
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((element) => element.naturalWidth)).toBeGreaterThan(0);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      const stored = await stack.tickets.db.ticket.findUnique({ where: { id: tickets[0].id } });
      assert.ok(stored.qrHash === createHash('sha256').update(credential).digest('hex'));
      assert.ok(!Buffer.from(stored.qrEncrypted).includes(Buffer.from(credential)));
      assert.ok(!(await page.content()).includes(credential));
      assert.ok(
        (await readQr(await page.request.get(`${listUrl}/${tickets[1].id}/qr`))) !== credential,
      );
      await page.reload();
      await expect(show).toHaveCount(2);
      assert.ok(
        (await readQr(await page.request.get(qrUrl))) === credential,
        'QR must survive reload',
      );

      const guest = await browser.newPage();
      assert.equal((await guest.request.get(qrUrl)).status(), 401);
      const codeUrl = qrUrl.replace(/\/qr$/, '/code');
      assert.equal((await guest.request.get(codeUrl)).status(), 401);
      await loginBuyer(guest, stack.origin, 'outsider');
      assert.equal((await guest.request.get(listUrl)).status(), 404);
      assert.equal((await guest.request.get(qrUrl)).status(), 404);
      assert.equal((await guest.request.get(codeUrl)).status(), 404);
      const code = await page.request.get(codeUrl);
      assert.equal(code.status(), 200);
      assert.equal(code.headers()['cache-control'], 'no-store');
      assert.ok((await code.json()).code === credential);
      const otherOrder = qrUrl.replace(order.id, randomUUID());
      assert.equal((await page.request.get(otherOrder)).status(), 404);

      const { db, origin } = stack.tickets;
      const job = () => db.deliveryJob.findUnique({ where: { id: order.id } });
      for (let attempt = 1; attempt < 4;) {
        const failed = await eventually(
          job,
          (item) => item?.attempts >= attempt && item.lease === null,
        );
        if (failed.state === 'DEAD') break;
        assert.equal(failed.state, 'PENDING');
        await db.deliveryJob.updateMany({
          where: { id: order.id, attempts: failed.attempts, lease: null },
          data: { nextRunAt: new Date(0) },
        });
        attempt = failed.attempts + 1;
      }
      assert.equal((await eventually(job, (item) => item?.state === 'DEAD')).attempts, 4);
      const messageId = `tickets-${order.id}@eventflow.test`;
      assert.equal((await findMail(messageId)).length, 0);
      assert.equal((await fetch(origin + '/internal/mail/dead')).status, 401);
      const authorization =
        'Bearer ' +
        (await new ClientCredentials(
          process.env.OIDC_ISSUER,
          'eventflow-mail-operator',
          process.env.MAIL_OPERATOR_SECRET,
        ).token());
      const operator = { authorization, 'idempotency-key': randomUUID() };
      const dead = await fetch(origin + '/internal/mail/dead', { headers: operator });
      assert.equal(dead.status, 200);
      assert.deepEqual((await dead.json()).jobs, [{ id: order.id, attempts: 4 }]);
      smtp.restore();
      for (let replay = 0; replay < 2; replay++) {
        const retry = await fetch(origin + `/internal/mail/${order.id}/retry`, {
          method: 'POST',
          headers: operator,
        });
        assert.equal(retry.status, 202);
      }
      await eventually(job, (item) => item?.state === 'SENT');
      const email = await receivedMail(messageId);
      assert.ok(email.Text.includes(pageUrl));
      assert.ok(!email.Text.includes(credential));
      assert.equal(await db.deliveryRetry.count(), 1);
      assert.equal(await db.ticket.count({ where: { orderId: order.id } }), 2);
    } finally {
      await browser?.close();
      try {
        await stack?.close();
      } finally {
        await smtp.close();
      }
    }
  },
);
