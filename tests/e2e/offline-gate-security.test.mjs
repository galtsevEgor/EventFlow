import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';
import { loginBuyer, publishForBooking } from './booking-setup.mjs';
import { gate, scan, localRows, purchase, virtualCamera } from './gate-setup.mjs';
import { QrCredentials } from '../../services/tickets/dist/qr-credentials.js';

test(
  'gate camera, server expiry, revoked roles, account isolation, quota failure and tab coordination preserve admission truth',
  { timeout: 300000 },
  async () => {
    const stack = await fullStack({ payments: true, tickets: true }),
      browser = await chromium.launch();
    try {
      const owner = await (await browser.newContext()).newPage(),
        headers = await loginBuyer(owner, stack.origin),
        root = stack.origin + '/api/v1';
      const org = await (
        await owner.request.post(root + '/organizations', {
          headers,
          data: { name: 'Безопасный офлайн-допуск' },
        })
      ).json();
      const now = Date.now(),
        minute = (n) => new Date(now + n * 60000).toISOString();
      const event = await publishForBooking(owner, stack.origin, headers, {
        organizationId: org.id,
        layout: { rows: 1, columns: 3 },
        schedule: {
          startsAt: minute(30),
          endsAt: minute(90),
          salesStartsAt: minute(-30),
          salesEndsAt: minute(29),
          admissionStartsAt: minute(-10),
          admissionEndsAt: minute(90),
        },
      });
      const order = await purchase(owner, stack.origin, headers, event, [
        'r1-s1',
        'r1-s2',
        'r1-s3',
      ]);
      const tickets = await stack.tickets.db.ticket.findMany({
        where: { orderId: order.id },
        orderBy: { number: 'asc' },
      });
      const qr = new QrCredentials(process.env.TICKET_QR_KEYS),
        credentials = tickets.map((ticket) => qr.reveal(ticket));
      const image = await owner.request.get(
        root + '/orders/' + order.id + '/tickets/' + tickets[0].id + '/qr',
      );
      assert.equal(image.status(), 200);
      await gate(owner, stack.origin, org.id, event);
      await owner.evaluate(() =>
        Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
          configurable: true,
          value: async () => {
            throw new DOMException('Denied', 'NotAllowedError');
          },
        }),
      );
      await owner.getByRole('button', { name: 'Открыть камеру', exact: true }).click();
      await expect(
        owner.getByText('Камера недоступна. Введите код вручную.', { exact: true }),
      ).toBeVisible();
      await owner.getByRole('button', { name: 'Закрыть камеру', exact: true }).click();
      await virtualCamera(owner, await image.body());
      await owner.context().setOffline(true);
      await owner.getByRole('button', { name: 'Открыть камеру', exact: true }).click();
      await expect(owner.getByRole('heading', { name: 'Очередь: 1', exact: true })).toBeVisible({
        timeout: 15000,
      });
      const [snapshot] = await localRows(owner, 'snapshots');
      await stack.tickets.db.offlineSession.update({
        where: { id: snapshot.id },
        data: { expiresAt: new Date(Date.now() - 1) },
      });
      await owner.context().setOffline(false);
      await expect(owner.getByText('Снимок истёк до синхронизации', { exact: true })).toBeVisible({
        timeout: 30000,
      });
      assert.equal(await stack.tickets.db.checkIn.count({ where: { result: 'ADMITTED' } }), 0);
      assert.equal((await localRows(owner))[0].sealed, null);

      const invitation = await owner.request.post(
        root + '/organizations/' + org.id + '/invitations',
        { headers, data: { email: 'staff@eventflow.test', role: 'STAFF' } },
      );
      assert.equal(invitation.status(), 201);
      const staff = await browser.newPage(),
        staffHeaders = await loginBuyer(staff, stack.origin, 'staff');
      assert.equal(
        (
          await staff.request.post(root + '/invitations/accept', {
            headers: staffHeaders,
            data: { token: (await invitation.json()).token },
          })
        ).status(),
        200,
      );
      const { user } = await (await staff.request.get(root + '/auth/session')).json();
      const assign = (assigned) =>
        owner.request.put(
          root + '/organizations/' + org.id + '/members/' + user.sub + '/events/' + event,
          { headers, data: { assigned } },
        );
      assert.equal((await assign(true)).status(), 200);
      await gate(staff, stack.origin, org.id, event);
      await staff.context().setOffline(true);
      await scan(staff, credentials[1]);
      await expect(staff.getByRole('heading', { name: 'Очередь: 1', exact: true })).toBeVisible();
      const [pending] = await localRows(staff);
      assert.equal((await assign(false)).status(), 200);
      await staff.context().setOffline(false);
      await expect(
        staff.getByText(
          'Права на мероприятие изменились. Подготовьте снимок заново после восстановления доступа.',
          { exact: true },
        ),
      ).toBeVisible({ timeout: 30000 });
      await expect(staff.getByLabel('Код билета', { exact: true })).toBeDisabled();
      assert.equal((await localRows(staff))[0].requestId, pending.requestId);
      assert.equal((await localRows(staff))[0].state, 'PENDING');
      assert.equal(await stack.tickets.db.checkIn.count({ where: { result: 'ADMITTED' } }), 0);
      assert.equal((await assign(true)).status(), 200);
      await staff.getByRole('button', { name: 'Подготовить мероприятие', exact: true }).click();
      await expect(staff.getByLabel('Код билета', { exact: true })).toBeEnabled();
      assert.equal((await localRows(staff))[0].requestId, pending.requestId);
      await staff.getByRole('button', { name: 'Синхронизировать', exact: true }).click();
      await expect(staff.getByText('Допуск подтверждён сервером', { exact: true })).toBeVisible();

      // Keep tab A's prior session while another tab updates the shared device identity.
      await owner.route('**/api/v1/auth/session', (route) => route.abort('failed'));
      const switched = await owner.context().newPage();
      await owner.context().clearCookies();
      await loginBuyer(switched, stack.origin, 'staff');
      await gate(switched, stack.origin, org.id, event);
      await expect(owner.getByText(/В снимке:/)).toHaveCount(0);
      await expect(owner.getByText('Снимок истёк до синхронизации', { exact: true })).toHaveCount(
        0,
      );
      await expect(owner.getByLabel('Код билета', { exact: true })).toBeDisabled();
      assert.equal((await localRows(switched)).length, 1);

      await switched.context().setOffline(true);
      await switched.evaluate(() => {
        const original = IDBObjectStore.prototype.add;
        IDBObjectStore.prototype.add = function (...args) {
          if (this.name === 'scans') throw new DOMException('Disk full', 'QuotaExceededError');
          return original.apply(this, args);
        };
      });
      await scan(switched, credentials[2]);
      await expect(
        switched.getByText(
          'Не удалось сохранить проверку: хранилище заполнено. Освободите место и повторите сканирование.',
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        switched.getByRole('heading', { name: 'Очередь: 0', exact: true }),
      ).toBeVisible();
      assert.equal((await localRows(switched)).length, 1);
      await switched.reload();
      await expect(switched.getByLabel('Код билета', { exact: true })).toBeEnabled();
      await scan(switched, credentials[2]);
      await expect(
        switched.getByRole('heading', { name: 'Очередь: 1', exact: true }),
      ).toBeVisible();
      const gateUrl = switched.url(),
        savedPending = (await localRows(switched)).find((row) => row.state === 'PENDING');
      await switched.context().clearCookies();
      await switched.context().setOffline(false);
      await expect
        .poll(async () => (await localRows(switched, 'meta')).some((row) => row.id === 'actor'))
        .toBe(false);
      const retained = (await localRows(switched)).find((row) => row.state === 'PENDING');
      assert.equal(retained.requestId, savedPending.requestId);
      assert.ok(retained.sealed);
      assert.equal(
        await stack.tickets.db.checkIn.count({
          where: { ticketId: tickets[2].id, result: 'ADMITTED' },
        }),
        0,
      );
      await switched.route('**/api/v1/offline-check-in/sync', (route) => route.abort('failed'));
      await loginBuyer(switched, stack.origin, 'staff');
      await switched.goto(gateUrl);
      await expect(switched.getByLabel('Код билета', { exact: true })).toBeEnabled();
      await switched.context().setOffline(true);
      await switched.unroute('**/api/v1/offline-check-in/sync');
      assert.equal(
        (await localRows(switched)).find((row) => row.state === 'PENDING').requestId,
        savedPending.requestId,
      );
      const tab = await switched.context().newPage();
      await tab.goto(switched.url());
      await expect(tab.getByLabel('Код билета', { exact: true })).toBeEnabled();
      await scan(tab, credentials[2]);
      await expect(
        tab.getByText('Этот билет уже проверен на этом устройстве.', { exact: true }),
      ).toBeVisible();
      switched.once('dialog', (dialog) => dialog.dismiss());
      await switched.getByRole('button', { name: 'Удалить локальные данные', exact: true }).click();
      await expect(
        switched.getByRole('heading', { name: 'Очередь: 1', exact: true }),
      ).toBeVisible();
      let requests = 0;
      for (const page of [tab, switched])
        page.on('request', (request) => {
          if (new URL(request.url()).pathname === '/api/v1/offline-check-in/sync') requests++;
        });
      await switched.context().setOffline(false);
      await expect(switched.getByText('Допуск подтверждён сервером', { exact: true })).toBeVisible({
        timeout: 30000,
      });
      await expect(tab.getByRole('heading', { name: 'Очередь: 0', exact: true })).toBeVisible();
      assert.equal(requests, 1);
      assert.equal(
        await stack.tickets.db.checkIn.count({
          where: { ticketId: tickets[2].id, result: 'ADMITTED' },
        }),
        1,
      );
      switched.once('dialog', (dialog) => dialog.accept());
      await switched.getByRole('button', { name: 'Удалить локальные данные', exact: true }).click();
      await expect(switched.getByText(/В снимке:/)).toHaveCount(0);
      const remaining = await localRows(switched);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].result.reason, 'SNAPSHOT_EXPIRED');
    } finally {
      await browser.close();
      await stack.close();
    }
  },
);
