import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { loginBuyer, publishForBooking } from './booking-setup.mjs';
import { fullStack } from './fixture.mjs';

function schedule(open) {
  const now = Date.now();
  const minute = (offset) => new Date(now + 60000 * offset).toISOString();
  return {
    startsAt: minute(30),
    endsAt: minute(90),
    salesStartsAt: minute(-30),
    salesEndsAt: minute(29),
    admissionStartsAt: minute(open ? -10 : 10),
    admissionEndsAt: minute(90),
  };
}

async function virtualCamera(page, image) {
  await page.evaluate(async (data) => {
    const qr = new Image();
    qr.src = 'data:image/png;base64,' + data;
    await qr.decode();
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 360;
        const context = canvas.getContext('2d');
        context.fillStyle = 'white';
        context.fillRect(0, 0, 360, 360);
        const stream = canvas.captureStream(12);
        const [track] = stream.getVideoTracks();
        const timer = setInterval(() => {
          if (track.readyState === 'ended') clearInterval(timer);
          else context.drawImage(qr, 32, 32, qr.width, qr.height);
        }, 70);
        return stream;
      },
    });
  }, image.toString('base64'));
}

test(
  'published event, paid order and assigned staff complete online admission through manual entry and camera',
  { timeout: 150000 },
  async () => {
    const stack = await fullStack({ payments: true, tickets: true });
    let browser;
    try {
      browser = await chromium.launch();
      const owner = await browser.newPage();
      const ownerHeaders = await loginBuyer(owner, stack.origin);
      const root = stack.origin + '/api/v1';
      const org = await owner.request.post(root + '/organizations', {
        headers: ownerHeaders,
        data: { name: 'Вход EventFlow' },
      });
      assert.equal(org.status(), 201);
      const { id: organizationId } = await org.json();
      const primary = await publishForBooking(owner, stack.origin, ownerHeaders, {
        organizationId,
        title: 'Вечер у сцены',
        schedule: schedule(true),
      });
      const other = await publishForBooking(owner, stack.origin, ownerHeaders, {
        organizationId,
        title: 'Другая сцена',
        schedule: schedule(true),
      });
      const closed = await publishForBooking(owner, stack.origin, ownerHeaders, {
        organizationId,
        title: 'Поздний сеанс',
        schedule: schedule(false),
      });
      const reservation = await owner.request.post(root + '/orders', {
        headers: { ...ownerHeaders, 'idempotency-key': randomUUID() },
        data: { saleId: primary, seatIds: ['r1-s1', 'r1-s2'] },
      });
      assert.equal(reservation.status(), 201);
      const { id: orderId } = await reservation.json();
      await owner.goto(stack.origin + '/orders/' + orderId);
      await owner.getByRole('button', { name: 'Перейти к оплате', exact: true }).click();
      await owner.getByRole('button', { name: /^Оплатить .* в демо$/ }).click();
      const show = owner.getByRole('button', { name: /^Показать QR/ });
      await expect(show).toHaveCount(2, { timeout: 20000 });
      const listUrl = root + `/orders/${orderId}/tickets`;
      const { tickets } = await (await owner.request.get(listUrl)).json();
      const images = await Promise.all(
        tickets.map(async ({ id }) => {
          const image = await owner.request.get(`${listUrl}/${id}/qr`);
          assert.equal(image.status(), 200);
          return image.body();
        }),
      );
      const first = owner.getByRole('listitem').filter({
        has: owner.getByRole('heading', { name: 'Ряд 1, место 1', exact: true }),
      });
      const reveal = first.getByRole('button', { name: /^Показать код для ручного ввода/ });
      await reveal.focus();
      await owner.keyboard.press('Enter');
      const manual = first.locator('code');
      await expect(manual).toBeVisible();
      const credential = await manual.textContent();
      assert.ok(credential && /^[A-Za-z0-9_-]{32}$/.test(credential));
      await first.getByRole('button', { name: /^Скрыть код/ }).press('Enter');
      await expect(manual).toHaveCount(0);

      const invited = await owner.request.post(
        root + `/organizations/${organizationId}/invitations`,
        {
          headers: ownerHeaders,
          data: { email: 'staff@eventflow.test', role: 'STAFF' },
        },
      );
      assert.equal(invited.status(), 201);
      const staff = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const staffHeaders = await loginBuyer(staff, stack.origin, 'staff');
      const accepted = await staff.request.post(root + '/invitations/accept', {
        headers: staffHeaders,
        data: { token: (await invited.json()).token },
      });
      assert.equal(accepted.status(), 200);
      const { user } = await (await staff.request.get(root + '/auth/session')).json();
      const checkUrl = root + '/check-in';
      const body = (eventId) => ({ eventId, organizationId, requestId: randomUUID(), credential });
      assert.equal((await staff.request.post(checkUrl, { data: body(primary) })).status(), 403);
      const forbidden = await staff.request.post(checkUrl, {
        headers: staffHeaders,
        data: body(primary),
      });
      assert.equal(forbidden.status(), 403);
      const assign = (assigned) =>
        owner.request.put(
          root + `/organizations/${organizationId}/members/${user.sub}/events/${primary}`,
          { headers: ownerHeaders, data: { assigned } },
        );
      assert.equal((await assign(true)).status(), 200);
      for (const [eventId, expected] of [
        [other, 'WRONG_EVENT'],
        [closed, 'WINDOW_CLOSED'],
      ]) {
        const response = await owner.request.post(checkUrl, {
          headers: ownerHeaders,
          data: body(eventId),
        });
        assert.equal(response.status(), 200);
        assert.equal((await response.json()).result, expected);
      }

      await staff.goto(stack.origin + '/organizer/?org=' + organizationId);
      await expect(staff.getByRole('heading', { name: 'Другая сцена' })).toHaveCount(0);
      await staff.getByRole('button', { name: 'Контроль входа' }).click();
      const dialog = staff.getByRole('dialog', { name: 'Контроль входа' });
      await staff.evaluate(() =>
        Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
          configurable: true,
          value: async () => {
            throw new DOMException('Permission denied', 'NotAllowedError');
          },
        }),
      );
      await dialog.getByRole('button', { name: 'Включить камеру' }).click();
      await expect(dialog.getByText('Камера недоступна.', { exact: false })).toBeVisible();
      const requestIds = [];
      let connected = false;
      let committed = false;
      await staff.route(checkUrl, async (route) => {
        requestIds.push(route.request().postDataJSON().requestId);
        if (connected) {
          const response = await route.fetch().catch(() => null);
          committed = response?.status() === 200 && (await response.json()).result === 'ADMITTED';
        }
        await route.abort('internetdisconnected');
      });
      await dialog.getByLabel('Код билета').fill(credential);
      await dialog.getByLabel('Код билета').press('Enter');
      const retry = dialog.getByRole('button', { name: 'Повторить проверку' });
      await expect(retry).toBeVisible();
      await expect(dialog.getByText('Вход разрешён')).toHaveCount(0);
      assert.equal(await stack.tickets.db.ticket.count({ where: { usedAt: { not: null } } }), 0);
      connected = true;
      const lost = staff.waitForEvent('requestfailed', (request) => request.url() === checkUrl);
      await retry.click();
      await lost;
      await expect(retry).toBeVisible();
      await expect(dialog.getByText('Вход разрешён')).toHaveCount(0);
      assert.equal(committed, true);
      assert.equal(await stack.tickets.db.ticket.count({ where: { usedAt: { not: null } } }), 1);
      await staff.unroute(checkUrl);
      await retry.click();
      await expect(dialog.getByText('Вход разрешён', { exact: true })).toBeVisible();
      await expect(dialog.getByLabel('Код билета')).toBeFocused();
      assert.equal(new Set(requestIds).size, 1);
      assert.equal(requestIds.length, 2);

      await dialog.getByLabel('Код билета').fill(credential);
      await dialog.getByRole('button', { name: 'Проверить билет' }).click();
      await expect(dialog.getByText('Билет уже использован', { exact: true })).toBeVisible();
      await virtualCamera(staff, images[1]);
      await dialog.getByRole('button', { name: 'Включить камеру' }).click();
      await expect(dialog.getByText('Вход разрешён', { exact: true })).toBeVisible();
      assert.equal(
        await staff.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.equal(await stack.tickets.db.checkIn.count({ where: { result: 'ADMITTED' } }), 2);
      assert.equal((await assign(false)).status(), 200);
      const revoked = await staff.request.post(checkUrl, {
        headers: staffHeaders,
        data: body(primary),
      });
      assert.equal(revoked.status(), 403);
    } finally {
      await browser?.close();
      await stack.close();
    }
  },
);
