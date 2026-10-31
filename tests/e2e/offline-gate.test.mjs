import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';
import { loginBuyer, publishForBooking } from './booking-setup.mjs';
import { QrCredentials } from '../../services/tickets/dist/qr-credentials.js';
async function gate(page, origin, org, event) {
  await page.goto(origin + '/organizer/gate/?org=' + org + '&event=' + event);
  await page.getByRole('button', { name: 'Подготовить мероприятие', exact: true }).click();
  await expect(page.getByText(/В снимке:/)).toBeVisible();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await expect(page.getByLabel('Код билета', { exact: true })).toBeEnabled();
}
async function scan(page, credential) {
  await page.getByLabel('Код билета', { exact: true }).fill(credential);
  await page.getByRole('button', { name: 'Сохранить проверку', exact: true }).click();
}
async function localRows(page, store = 'scans') {
  return page.evaluate(async (name) => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('eventflow-gate');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const r = db.transaction(name).objectStore(name).getAll();
        r.onsuccess = () =>
          resolve(
            name === 'vaults'
              ? r.result.map((v) => ({ id: v.id, extractable: v.key.extractable }))
              : r.result,
          );
        r.onerror = () => reject(r.error);
      });
    } finally {
      db.close();
    }
  }, store);
}
test(
  'PWA keeps encrypted scans across offline reload, resolves two-device conflicts and survives a lost sync ACK',
  { timeout: 300000 },
  async () => {
    const stack = await fullStack({ payments: true, tickets: true }),
      browser = await chromium.launch();
    const workerPath = resolve('apps/organizer/dist/sw.js'),
      originalWorker = readFileSync(workerPath);
    try {
      const owner = await browser.newPage({ viewport: { width: 390, height: 844 } }),
        errors = [];
      owner.on('pageerror', (e) => errors.push(e.message));
      const headers = await loginBuyer(owner, stack.origin),
        root = stack.origin + '/api/v1';
      const org = await (
        await owner.request.post(root + '/organizations', {
          headers,
          data: { name: 'PWA ворота E20' },
        })
      ).json();
      const now = Date.now(),
        minute = (n) => new Date(now + n * 60000).toISOString();
      const event = await publishForBooking(owner, stack.origin, headers, {
        organizationId: org.id,
        layout: { rows: 1, columns: 4 },
        schedule: {
          startsAt: minute(30),
          endsAt: minute(90),
          salesStartsAt: minute(-30),
          salesEndsAt: minute(29),
          admissionStartsAt: minute(-10),
          admissionEndsAt: minute(90),
        },
      });
      const orders = [];
      for (const seatId of ['r1-s1', 'r1-s2']) {
        const r = await owner.request.post(root + '/orders', {
          headers: { ...headers, 'idempotency-key': randomUUID() },
          data: { saleId: event, seatIds: [seatId] },
        });
        assert.equal(r.status(), 201);
        const order = await r.json();
        orders.push(order);
        assert.equal(
          (
            await owner.request.post(root + '/orders/' + order.id + '/payment-attempt', {
              headers: { ...headers, 'idempotency-key': randomUUID() },
              data: {},
            })
          ).status(),
          202,
        );
        await owner.goto(stack.origin + '/orders/' + order.id);
        await expect(owner.getByText('Демо-режим · без списания денег')).toBeVisible({
          timeout: 15000,
        });
        assert.ok(
          [200, 202].includes(
            (
              await owner.request.post(
                root + '/orders/' + order.id + '/payment-attempt/fake-confirm',
                { headers, data: { outcome: 'success' } },
              )
            ).status(),
          ),
        );
        await expect
          .poll(() => stack.tickets.db.ticket.count({ where: { orderId: order.id } }))
          .toBe(1);
      }
      const tickets = await stack.tickets.db.ticket.findMany({
        where: { saleId: event },
        orderBy: { number: 'asc' },
      });
      const credentials = tickets.map((t) =>
        new QrCredentials(process.env.TICKET_QR_KEYS).reveal(t),
      );
      assert.equal(
        (
          await owner.request.post(root + '/offline-check-in/sessions', {
            data: { organizationId: org.id, eventId: event, deviceId: randomUUID() },
          })
        ).status(),
        403,
      );
      const second = await browser.newPage();
      await loginBuyer(second, stack.origin);
      await gate(owner, stack.origin, org.id, event);
      await gate(second, stack.origin, org.id, event);
      const [firstSnapshot] = await localRows(owner, 'snapshots'),
        [secondSnapshot] = await localRows(second, 'snapshots');
      assert.notEqual(firstSnapshot.deviceId, secondSnapshot.deviceId);
      await owner.context().setOffline(true);
      await second.context().setOffline(true);
      await scan(owner, credentials[0]);
      await scan(second, credentials[0]);
      await expect(owner.getByRole('heading', { name: 'Очередь: 1', exact: true })).toBeVisible();
      await expect(second.getByRole('heading', { name: 'Очередь: 1', exact: true })).toBeVisible();
      assert.equal(await stack.tickets.db.checkIn.count({ where: { result: 'ADMITTED' } }), 0);
      await owner.reload();
      try {
        await expect(owner.getByLabel('Код билета', { exact: true })).toBeEnabled();
      } catch {
        throw new Error(
          'Offline reload did not become ready: ' + (await owner.locator('main').innerText()),
        );
      }
      await expect(owner.getByRole('heading', { name: 'Очередь: 1', exact: true })).toBeVisible();
      await scan(owner, credentials[0]);
      await expect(
        owner.getByText('Этот билет уже проверен на этом устройстве.', { exact: true }),
      ).toBeVisible();
      const stored = await localRows(owner);
      assert.equal(stored.length, 1);
      assert.ok(!JSON.stringify(stored).includes(credentials[0]));
      const vaults = await localRows(owner, 'vaults');
      assert.equal(vaults[0].extractable, false);
      let lost = false,
        hold = true;
      await owner.route('**/api/v1/offline-check-in/sync', async (route) => {
        if (hold) await route.abort('failed');
        else if (!lost) {
          const result = await route.fetch();
          assert.equal(result.status(), 200);
          lost = true;
          await route.abort('failed');
        } else await route.continue();
      });
      await owner.context().setOffline(false);
      writeFileSync(
        workerPath,
        Buffer.concat([originalWorker, Buffer.from('\n// gate-update-' + randomUUID())]),
      );
      await owner.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        await registration.update();
        window.gateUpdateMarker = 'pending';
      });
      const update = owner.getByRole('button', { name: 'Обновить приложение', exact: true });
      await expect(update).toBeVisible({ timeout: 15000 });
      await expect(update).toBeDisabled();
      assert.equal(await owner.evaluate(() => window.gateUpdateMarker), 'pending');
      hold = false;
      await owner.getByRole('button', { name: 'Синхронизировать', exact: true }).click();
      await expect.poll(() => lost, { timeout: 30000 }).toBe(true);
      await expect(owner.getByRole('heading', { name: 'Очередь: 1', exact: true })).toBeVisible();
      await owner.getByRole('button', { name: 'Синхронизировать', exact: true }).click();
      await expect(owner.getByText('Допуск подтверждён сервером', { exact: true })).toBeVisible({
        timeout: 20000,
      });
      await expect(owner.getByRole('heading', { name: 'Очередь: 0', exact: true })).toBeVisible();
      assert.equal((await localRows(owner))[0].sealed, null);
      await second.context().setOffline(false);
      await expect(
        second.getByText('Конфликт: билет уже использован', { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      assert.equal(
        await stack.tickets.db.checkIn.count({
          where: { ticketId: tickets[0].id, result: 'ADMITTED' },
        }),
        1,
      );
      await owner.context().setOffline(true);
      await scan(owner, credentials[1]);
      await expect(owner.getByRole('heading', { name: 'Очередь: 1', exact: true })).toBeVisible();
      await stack.tickets.db.refundGate.create({
        data: {
          orderId: orders[1].id,
          operationId: randomUUID(),
          saleId: event,
          organizationId: org.id,
          state: 'REVOKED',
        },
      });
      await owner.context().setOffline(false);
      await expect(owner.getByText('Билет аннулирован', { exact: true })).toBeVisible({
        timeout: 30000,
      });
      await expect(update).toBeEnabled();
      await Promise.all([owner.waitForEvent('load'), update.click()]);
      assert.equal(await owner.evaluate(() => window.gateUpdateMarker ?? null), null);
      await expect(owner.getByText('Допуск подтверждён сервером', { exact: true })).toBeVisible();
      await expect(owner.getByText('Билет аннулирован', { exact: true })).toBeVisible();
      const cached = await owner.evaluate(async () => {
        const names = await caches.keys();
        return (
          await Promise.all(
            names.map(async (n) =>
              (await (await caches.open(n)).keys()).map((r) => new URL(r.url).pathname),
            ),
          )
        ).flat();
      });
      assert.ok(cached.length > 0);
      assert.ok(cached.every((path) => !path.startsWith('/api/')));
      const cdp = await owner.context().newCDPSession(owner),
        manifest = await cdp.send('Page.getAppManifest');
      assert.deepEqual(manifest.errors, []);
      assert.equal(JSON.parse(manifest.data).scope, '/organizer/gate/');
      assert.deepEqual((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors, []);
      await cdp.detach();
      const main = await browser.newPage();
      await main.goto(stack.origin + '/organizer/');
      assert.equal(await main.evaluate(() => navigator.serviceWorker.controller), null);
      assert.equal(
        await owner.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.deepEqual(errors, []);
    } finally {
      writeFileSync(workerPath, originalWorker);
      await browser.close();
      await stack.close();
    }
  },
);
