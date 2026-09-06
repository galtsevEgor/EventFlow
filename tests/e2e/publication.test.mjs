import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';
import { MessageWorker } from '../../packages/messaging/dist/index.js';

test(
  'organizer sees durable pending publication and acknowledgment after Booking recovers',
  { timeout: 90000 },
  async () => {
    const stack = await fullStack();
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const owner = JSON.parse(readFileSync('work/local/demo-users.json', 'utf8')).find(
        (user) => user.username === 'owner',
      );
      await page.goto(stack.origin + '/organizer/');
      await page.getByRole('link', { name: 'Войти', exact: true }).click();
      await page.locator('input[name=username]').fill(owner.email);
      await page.locator('input[name=password]').fill(owner.password);
      await page.locator('#kc-login').click();
      await expect(
        page.getByRole('button', { name: 'Создать организацию', exact: true }),
      ).toBeVisible();
      const session = await (await page.request.get(stack.origin + '/api/v1/auth/session')).json();
      const headers = { origin: stack.origin, 'x-csrf-token': session.csrfToken };
      const org = await (
        await page.request.post(stack.origin + '/api/v1/organizations', {
          headers,
          data: { name: 'Команда публикации' },
        })
      ).json();
      const draft = await (
        await page.request.post(`${stack.origin}/api/v1/organizations/${org.id}/events`, {
          headers,
          data: { title: 'Концерт в саду', description: 'Живая музыка летним вечером.' },
        })
      ).json();
      const path = `${stack.origin}/api/v1/organizations/${org.id}/events/${draft.id}`;
      const saved = await page.request.put(path + '/configuration', {
        headers,
        data: {
          revision: 0,
          configuration: {
            city: 'Кишинёв',
            address: 'Улица Музыки, 12',
            timeZone: 'Europe/Chisinau',
            startsAt: '2035-06-01T16:00:00Z',
            endsAt: '2035-06-01T18:00:00Z',
            salesStartsAt: '2035-05-01T09:00:00Z',
            salesEndsAt: '2035-06-01T15:30:00Z',
            admissionStartsAt: '2035-06-01T15:00:00Z',
            admissionEndsAt: '2035-06-01T18:00:00Z',
            currency: 'EUR',
            categories: [{ id: 'standard', name: 'Стандарт', priceMinor: 2500 }],
            layout: { rows: 2, columns: 3, defaultCategoryId: 'standard', overrides: [] },
          },
        },
      });
      assert.equal(saved.status(), 200);
      const png = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 100;
        canvas.height = 100;
        return canvas.toDataURL('image/png').split(',')[1];
      });
      const cover = await page.request.post(path + '/cover', {
        headers,
        multipart: {
          file: { name: 'poster.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') },
        },
      });
      assert.equal(cover.status(), 201);
      const asset = (await cover.json()).coverId;
      await page.reload();
      await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
      await expect(page.getByText('Готовится к публикации', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Настроить продажи' })).toBeDisabled();
      await page.reload();
      await expect(page.getByText('Готовится к публикации', { exact: true })).toBeVisible();
      assert.equal(
        (await page.request.get(`${stack.origin}/api/v1/covers/${asset}`)).status(),
        404,
      );
      const booking = await stack.startBooking();
      await expect(page.getByText('Опубликовано', { exact: true })).toBeVisible({ timeout: 15000 });
      assert.equal(
        (await page.request.get(`${stack.origin}/api/v1/covers/${asset}`)).status(),
        200,
      );
      const worker = booking.app.get(MessageWorker);
      await worker.stop();
      await page.getByRole('button', { name: 'Приостановить продажи' }).click();
      await expect(page.getByText('Ожидаем подтверждение паузы…')).toBeVisible();
      await expect(
        page.getByText('Продажи разрешены по расписанию', { exact: true }),
      ).toBeVisible();
      await page.reload();
      await expect(page.getByText('Ожидаем подтверждение паузы…')).toBeVisible();
      worker.start();
      await expect(page.getByText('Продажи на паузе', { exact: true })).toBeVisible({
        timeout: 15000,
      });
      await page.getByRole('button', { name: 'Возобновить продажи' }).click();
      await expect(page.getByText('Продажи разрешены по расписанию', { exact: true })).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByText('Ожидаем подтверждение возобновления…')).toHaveCount(0);
      const recovery = await (
        await page.request.post(`${stack.origin}/api/v1/organizations/${org.id}/events`, {
          headers,
          data: { title: 'Повтор публикации', description: 'Проверка восстановления публикации.' },
        })
      ).json();
      const recoveryPath = `${stack.origin}/api/v1/organizations/${org.id}/events/${recovery.id}`;
      await page.request.put(recoveryPath + '/configuration', {
        headers,
        data: { revision: 0, configuration: (await saved.json()).configuration },
      });
      await page.request.post(recoveryPath + '/cover', {
        headers,
        multipart: {
          file: { name: 'poster.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') },
        },
      });
      const sourceSale = await booking.db.sale.findUniqueOrThrow({ where: { id: draft.id } });
      await booking.db.sale.create({
        data: {
          ...sourceSale,
          id: recovery.id,
          snapshotHash: '0'.repeat(64),
          paused: false,
          commandVersion: 0,
        },
      });
      await page.reload();
      const card = page
        .getByRole('article')
        .filter({ has: page.getByRole('heading', { name: 'Повтор публикации', exact: true }) });
      await card.getByRole('button', { name: 'Опубликовать', exact: true }).click();
      await expect(card.getByText('Публикация отклонена', { exact: true })).toBeVisible({
        timeout: 15000,
      });
      await page.reload();
      await expect(card.getByRole('button', { name: 'Повторить публикацию' })).toBeVisible();
      await booking.db.sale.delete({ where: { id: recovery.id } });
      const retryRequest = page.waitForRequest((request) =>
        request.url().endsWith('/publication/retry'),
      );
      await card.getByRole('button', { name: 'Повторить публикацию' }).click();
      assert.match((await retryRequest).headers()['idempotency-key'], /^[0-9a-f-]{36}$/);
      await expect(card.getByText('Опубликовано', { exact: true })).toBeVisible({ timeout: 15000 });
      assert.equal(await booking.db.seatInventory.count({ where: { saleId: recovery.id } }), 6);
    } finally {
      await browser.close();
      await stack.close();
    }
  },
);
