import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';

test(
  'browser cover upload is protected by CSRF, rejects fake images and displays an approved private preview',
  { timeout: 90_000 },
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
      await page.getByRole('button', { name: 'Создать организацию', exact: true }).click();
      await page.getByLabel('Название организации', { exact: true }).fill('Команда афиш');
      await page.getByRole('button', { name: 'Создать', exact: true }).click();
      await page.getByRole('button', { name: 'Новое мероприятие', exact: true }).click();
      await page.getByLabel('Название мероприятия').fill('Событие с афишей');
      await page.getByRole('button', { name: 'Сохранить черновик' }).click();
      await page.getByRole('button', { name: 'Афиша', exact: true }).click();
      await page.getByLabel('Файл афиши').setInputFiles({
        name: 'fake.png',
        mimeType: 'image/png',
        buffer: Buffer.from('<html>not an image</html>'),
      });
      await page.getByRole('button', { name: 'Загрузить афишу' }).click();
      await expect(page.getByRole('alert')).toContainText('Фактический формат');
      const png = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 100;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#336644';
        ctx.fillRect(0, 0, 160, 100);
        return canvas.toDataURL('image/png').split(',')[1];
      });
      await page.getByLabel('Файл афиши').setInputFiles({
        name: 'poster.png',
        mimeType: 'image/png',
        buffer: Buffer.from(png, 'base64'),
      });
      const saved = page.waitForResponse(
        (response) => response.request().method() === 'POST' && response.url().endsWith('/cover'),
      );
      await page.getByRole('button', { name: 'Загрузить афишу' }).click();
      const response = await saved;
      assert.equal(response.status(), 201);
      const event = await response.json();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const image = page.getByRole('img', { name: 'Афиша: Событие с афишей' });
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((element) => element.naturalWidth)).toBe(160);
      assert.equal(
        (await page.request.get(`${stack.origin}/api/v1/covers/${event.coverId}`)).status(),
        404,
      );
      const rejected = await page.request.post(
        `${stack.origin}/api/v1/organizations/${event.organizationId}/events/${event.id}/cover`,
        {
          headers: { origin: stack.origin },
          multipart: {
            file: { name: 'poster.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') },
          },
        },
      );
      assert.equal(rejected.status(), 403);
      await page.reload();
      await expect(page.getByRole('img', { name: 'Афиша: Событие с афишей' })).toBeVisible();
    } finally {
      await browser.close();
      await stack.close();
    }
  },
);
