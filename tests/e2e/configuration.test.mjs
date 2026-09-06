import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';

test(
  'organizer configures timezone overlap, price categories and an accessible seat grid',
  { timeout: 90_000 },
  async () => {
    const stack = await fullStack();
    const browser = await chromium.launch();
    try {
      const owner = JSON.parse(readFileSync('work/local/demo-users.json', 'utf8')).find(
        (user) => user.username === 'owner',
      );
      const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
      page.setDefaultTimeout(15_000);
      await page.goto(stack.origin + '/organizer/');
      await page.getByRole('link', { name: 'Войти', exact: true }).click();
      await page.locator('input[name=username]').fill(owner.email);
      await page.locator('input[name=password]').fill(owner.password);
      await page.locator('#kc-login').click();
      await page.getByRole('button', { name: 'Создать организацию', exact: true }).click();
      await page.getByLabel('Название организации', { exact: true }).fill('Ночная сцена');
      await page.getByRole('button', { name: 'Создать', exact: true }).click();
      await page.getByRole('button', { name: 'Новое мероприятие', exact: true }).click();
      await page.getByLabel('Название мероприятия').fill('Ночной концерт');
      await page.getByRole('button', { name: 'Сохранить черновик' }).click();
      await page.getByRole('button', { name: 'Настроить продажи' }).click();
      await page.getByLabel('Город', { exact: true }).fill('Кишинёв');
      await page.getByLabel('Адрес площадки').fill('Улица Музыки, 12');
      await page.getByLabel('Начало мероприятия', { exact: true }).fill('2030-03-31T03:30');
      await expect(page.getByText('Этого времени нет из-за перевода часов.')).toBeVisible();
      await page.getByLabel('Начало мероприятия', { exact: true }).fill('2030-10-27T03:30');
      const offset = page.getByLabel('Начало мероприятия: смещение UTC');
      await expect(offset).toBeVisible();
      await expect(offset).toHaveValue('');
      await offset.selectOption('+02:00');
      for (const [label, value] of [
        ['Окончание мероприятия', '2030-10-27T05:00'],
        ['Начало продаж', '2030-10-01T10:00'],
        ['Окончание продаж', '2030-10-26T22:00'],
        ['Открытие входа', '2030-10-27T02:00'],
        ['Закрытие входа', '2030-10-27T05:00'],
      ])
        await page.getByLabel(label, { exact: true }).fill(value);
      await page.getByLabel('Рядов', { exact: true }).fill('2');
      await page.getByLabel('Мест в ряду', { exact: true }).fill('3');
      await page.getByRole('button', { name: 'Добавить категорию' }).click();
      await page.getByLabel('Категория 2', { exact: true }).fill('Первый ряд');
      await page.getByLabel('Цена категории 2, EUR', { exact: true }).fill('29,90');
      await page
        .getByLabel('Назначаемая категория', { exact: true })
        .selectOption({ label: 'Первый ряд' });
      const first = page.getByRole('button', { name: /^Ряд 1, место 1,/ });
      await first.focus();
      await page.keyboard.press('Enter');
      await expect(first).toHaveAttribute('aria-label', /Первый ряд/);
      await page.getByLabel('Действие с местом').selectOption('availability');
      const disabled = page.getByRole('button', { name: /^Ряд 1, место 2,/ });
      await disabled.click();
      await expect(disabled).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByText('Активных мест: 5')).toBeVisible();
      const saved = page.waitForResponse(
        (response) =>
          response.request().method() === 'PUT' && response.url().endsWith('/configuration'),
      );
      await page.getByRole('button', { name: 'Сохранить настройки' }).click();
      const response = await saved;
      assert.equal(response.status(), 200);
      const draft = await response.json();
      assert.equal(draft.configuration.startsAt, '2030-10-27T01:30:00.000Z');
      assert.equal(draft.configuration.categories[1].priceMinor, 2990);
      assert.equal(draft.configuration.layout.overrides.length, 2);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.reload();
      await page.getByRole('button', { name: 'Настроить продажи' }).click();
      await expect(page.getByLabel('Начало мероприятия: смещение UTC')).toHaveValue('+02:00');
      await expect(page.getByLabel('Цена категории 2, EUR', { exact: true })).toHaveValue('29.90');
      await expect(page.getByRole('button', { name: /^Ряд 1, место 2,/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      mkdirSync('work/e2', { recursive: true });
      await page.screenshot({ path: 'work/e2/configuration-desktop.png' });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: 'work/e2/configuration-mobile.png' });
      await page.getByLabel('Рядов', { exact: true }).fill('20');
      await page.getByLabel('Мест в ряду', { exact: true }).fill('50');
      await expect(page.getByRole('button', { name: /^Ряд \d+, место \d+,/ })).toHaveCount(1000);
      const last = page.getByRole('button', { name: /^Ряд 20, место 50,/ });
      await page.getByLabel('Действие с местом').selectOption('availability');
      await last.focus();
      await page.keyboard.press('Enter');
      await expect(last).toHaveAttribute('aria-pressed', 'true');
      await page.getByLabel('Рядов', { exact: true }).fill('21');
      await expect(page.getByRole('alert')).toContainText('не более 1 000');
    } finally {
      await browser.close();
      await stack.close();
    }
  },
);
