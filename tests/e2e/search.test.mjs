import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';
import { loginBuyer, publishForBooking } from './booking-setup.mjs';
let stack, browser, jazz, second, privateTitle;
before(
  async () => {
    stack = await fullStack({ booking: true, search: true });
    browser = await chromium.launch();
    const page = await browser.newPage();
    const headers = await loginBuyer(page, stack.origin);
    jazz = await publishForBooking(page, stack.origin, headers, { title: 'Джаз в саду' });
    second = await publishForBooking(page, stack.origin, headers, { title: 'Джаз на закате' });
    const organization = await (
      await page.request.post(stack.origin + '/api/v1/organizations', {
        headers,
        data: { name: 'Private search fixture' },
      })
    ).json();
    privateTitle = 'Секретный джазовый черновик';
    await page.request.post(stack.origin + '/api/v1/organizations/' + organization.id + '/events', {
      headers,
      data: { title: privateTitle },
    });
    await expect
      .poll(
        async () => {
          const result = await page.request.get(
            stack.origin + '/api/v1/search/events?q=' + encodeURIComponent('джас'),
          );
          return result.ok() ? (await result.json()).total : -1;
        },
        { timeout: 30000 },
      )
      .toBe(2);
    await page.close();
  },
  { timeout: 150000 },
);
after(async () => {
  await browser?.close();
  await stack?.close();
});

test(
  'OpenSearch discovery is server rendered with shareable filters, pagination, keyboard suggestions and mobile layout',
  { timeout: 90000 },
  async () => {
    const page = await browser.newPage();
    try {
      const url =
        stack.origin +
        '/?' +
        new URLSearchParams({
          q: 'джас',
          city: 'Кишинёв',
          minPrice: '20',
          maxPrice: '30',
          sort: 'price_asc',
          pageSize: '1',
        });
      const html = await (await page.request.get(url)).text();
      assert.match(html, /Джаз/);
      assert.ok(!html.includes(privateTitle));
      await page.goto(url);
      await expect(page.getByText('Найдено: 2', { exact: true })).toBeVisible();
      await expect(page.getByLabel('Цена от, €')).toHaveValue('20');
      await expect(page.getByLabel('Сортировка')).toHaveValue('price_asc');
      await page.getByRole('link', { name: 'Следующая →' }).click();
      await expect(page).toHaveURL(/page=2/);
      assert.equal(new URL(page.url()).searchParams.get('minPrice'), '20');
      assert.equal(new URL(page.url()).searchParams.get('page'), '2');
      await expect(page.locator('.public-event-card')).toHaveCount(1);
      const input = page.getByRole('combobox', { name: 'Название или описание' });
      await input.fill('Джа');
      await expect(page.getByRole('option', { name: /Джаз в саду/ })).toBeVisible();
      await input.press('Escape');
      await expect(input).toHaveAttribute('aria-expanded', 'false');
      await expect(input).toHaveValue('Джа');
      await input.blur();
      await input.focus();
      await expect(page.getByRole('option', { name: /Джаз в саду/ })).toBeVisible();
      await input.press('ArrowDown');
      await input.press('Enter');
      await expect(page).toHaveURL(/\/events\/[a-f0-9-]+$/);
      await expect(page.getByRole('heading', { name: /Джаз/, level: 1 })).toBeVisible();
      await page.goto(url);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole('button', { name: 'Найти события' })).toBeVisible();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      mkdirSync('work/e17/screenshots', { recursive: true });
      await page.screenshot({ path: 'work/e17/screenshots/search-mobile.png', fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: 'work/e17/screenshots/search-desktop.png', fullPage: true });
    } finally {
      await page.close();
    }
  },
);

test(
  'late autocomplete replies and Escape cannot replace the current suggestion list',
  { timeout: 60000 },
  async () => {
    const page = await browser.newPage();
    let release, entered;
    const received = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await page.route('**/api/v1/search/suggest?*', async (route) => {
        const query = new URL(route.request().url()).searchParams.get('q');
        if (query === 'старый') {
          entered();
          await gate;
        }
        await route
          .fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
              suggestions: [
                {
                  id: query === 'старый' ? jazz : second,
                  title:
                    query === 'старый'
                      ? 'Устаревшая подсказка'
                      : '<script>Новая подсказка</script>',
                  city: 'Кишинёв',
                },
              ],
              limited: false,
            }),
          })
          .catch(() => {});
      });
      await page.goto(stack.origin);
      const input = page.getByRole('combobox', { name: 'Название или описание' });
      await input.fill('старый');
      await received;
      await input.fill('новый');
      await expect(page.getByRole('option', { name: /Новая подсказка/ })).toBeVisible();
      release();
      await expect(page.getByRole('option', { name: /Устаревшая/ })).toHaveCount(0);
      assert.equal(await page.locator('.search-suggestions script').count(), 0);
      await input.press('Escape');
      await expect(input).toHaveAttribute('aria-expanded', 'false');
      await input.press('Enter');
      await expect(page).toHaveURL(/\?q=/);
    } finally {
      release?.();
      await page.close();
    }
  },
);

test(
  'real Search service outage keeps SSR filters usable through Catalog fallback',
  { timeout: 60000 },
  async () => {
    const page = await browser.newPage();
    try {
      await stack.stopSearch();
      await page.goto(
        stack.origin +
          '/?' +
          new URLSearchParams({
            q: 'Джаз',
            city: 'Кишинёв',
            minPrice: '20',
            maxPrice: '30',
            sort: 'price_desc',
          }),
      );
      await expect(page.getByRole('status').filter({ hasText: 'упрощённый поиск' })).toBeVisible();
      await expect(page.locator('.public-event-card')).toHaveCount(2);
      await expect(page.getByLabel('Цена до, €')).toHaveValue('30');
      await page.goto(stack.origin + '/?minPrice=1.234');
      await expect(page.locator('main').getByRole('alert')).toContainText('с точностью до цента');
    } finally {
      await page.close();
    }
  },
);
