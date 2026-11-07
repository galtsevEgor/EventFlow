import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';
import { loginBuyer } from './booking-setup.mjs';
import { mappedSeatPoint, venueDraft, webglArgs } from './venue-setup.mjs';

test(
  'organizer edits real WebGL geometry, rejects collisions, restores history and persists the plan',
  { timeout: 180000 },
  async () => {
    const stack = await fullStack(),
      browser = await chromium.launch({ args: webglArgs });
    try {
      const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
      page.setDefaultTimeout(20000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const headers = await loginBuyer(page, stack.origin);
      const draft = await venueDraft(page, stack.origin, headers);
      await page.goto(`${stack.origin}/organizer/?org=${draft.organizationId}`);
      await page.getByRole('button', { name: 'Настроить продажи', exact: true }).click();
      await page.getByLabel('Рядов', { exact: true }).fill('1.5');
      await expect(
        page.getByRole('button', { name: 'Открыть конструктор зала', exact: true }),
      ).toBeDisabled();
      await page.getByLabel('Рядов', { exact: true }).fill('2');
      await page.getByRole('button', { name: 'Открыть конструктор зала', exact: true }).click();
      const editor = page.getByRole('region', { name: 'Конструктор зала', exact: true });
      await expect(editor.locator('canvas')).toHaveCount(1);
      await editor.getByLabel('Рядов в новом плане', { exact: true }).fill('3');
      await editor.getByRole('button', { name: 'Построить ряды', exact: true }).click();
      await editor.getByLabel('Выбираемый ряд', { exact: true }).fill('3');
      await editor.getByRole('button', { name: 'Выбрать ряд', exact: true }).click();
      await editor.getByRole('button', { name: 'Отменить действие', exact: true }).click();
      await expect(
        editor.getByRole('status').filter({ hasText: 'Выделено мест: 0' }),
      ).toBeVisible();
      await expect(
        editor.getByRole('button', { name: 'Повторить действие', exact: true }),
      ).toBeEnabled();
      await editor.getByLabel('Выбираемый ряд', { exact: true }).fill('1');
      await editor.getByRole('button', { name: 'Выбрать ряд', exact: true }).click();
      await expect(
        editor.getByRole('status').filter({ hasText: 'Выделено мест: 3' }),
      ).toBeVisible();
      await editor.getByRole('button', { name: 'Сдвинуть вниз', exact: true }).click();
      await editor.getByRole('button', { name: 'Сдвинуть вниз', exact: true }).click();
      await expect(editor.getByRole('alert')).toContainText('Места пересекаются');
      await editor.getByRole('button', { name: 'Отменить действие', exact: true }).click();
      await expect(editor.getByRole('alert')).toHaveCount(0);
      await editor.getByRole('button', { name: 'Повторить действие', exact: true }).click();
      await editor.getByRole('button', { name: 'Отменить действие', exact: true }).click();
      await editor.getByRole('button', { name: 'Выделить все', exact: true }).click();
      await editor.getByRole('button', { name: 'Повернуть +15°', exact: true }).click();
      await editor.getByLabel('Категория выделенных мест', { exact: true }).selectOption('vip');
      await editor.getByRole('button', { name: 'Назначить категорию группе', exact: true }).click();
      await editor.getByLabel('Название объекта', { exact: true }).fill('Партер на плане');
      await editor.getByRole('button', { name: 'Добавить объект', exact: true }).click();
      await editor.getByRole('button', { name: 'Список мест', exact: true }).click();
      await editor.getByRole('button', { name: /^Ряд 1, место 1 ·/ }).click();
      await editor.getByRole('button', { name: 'Отключить места', exact: true }).click();
      await editor.getByRole('button', { name: 'План зала', exact: true }).click();
      let submitted, release;
      const saving = new Promise((resolve) => {
        release = resolve;
      });
      await page.route('**/configuration', async (route) => {
        submitted = route.request().postDataJSON();
        await saving;
        await route.continue();
      });
      const saved = page.waitForResponse(
        (r) => r.request().method() === 'PUT' && r.url().endsWith('/configuration'),
      );
      await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
      try {
        await expect.poll(() => Boolean(submitted)).toBeTruthy();
        await expect(
          page.getByRole('button', { name: 'Сохранить настройки', exact: true }),
        ).toBeDisabled();
        const point = await mappedSeatPoint(page, submitted.configuration.layout.map, 'r1-s1');
        const before = await editor.locator('canvas').screenshot();
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await page.mouse.move(point.x, point.y - 20 * point.scale, { steps: 5 });
        await page.mouse.up();
        assert.ok(
          before.equals(await editor.locator('canvas').screenshot()),
          'Saving must freeze canvas geometry',
        );
      } finally {
        release();
      }
      const response = await saved;
      assert.equal(response.status(), 200, await response.text());
      const data = await response.json(),
        map = data.configuration.layout.map;
      assert.equal(map.seats.length, 6);
      assert.ok(map.seats.every((seat) => seat.rotation === 15));
      assert.ok(map.features.some((feature) => feature.label === 'Партер на плане'));
      assert.equal(data.configuration.layout.overrides.filter((seat) => seat.disabled).length, 1);
      assert.ok(data.configuration.layout.overrides.every((seat) => seat.categoryId === 'vip'));
      await page.reload();
      await page.getByRole('button', { name: 'Настроить продажи', exact: true }).click();
      await expect(page.locator('canvas')).toHaveCount(1);
      mkdirSync('work/e22', { recursive: true });
      await page.screenshot({ path: 'work/e22/editor-desktop.png' });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: 'work/e22/editor-mobile.png' });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await stack.close();
    }
  },
);
