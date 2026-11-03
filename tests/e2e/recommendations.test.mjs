import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';
import { loginBuyer, publishForBooking } from './booking-setup.mjs';

test(
  'real local embeddings feed SSR recommendations with truthful cold fallback and immediate Catalog exclusion',
  { timeout: 240000 },
  async () => {
    const stack = await fullStack({ booking: true, recommendations: true }),
      browser = await chromium.launch();
    try {
      await stack.recommendations.stopWorker();
      const owner = await browser.newPage(),
        headers = await loginBuyer(owner, stack.origin),
        root = stack.origin + '/api/v1';
      const org = await (
        await owner.request.post(root + '/organizations', {
          headers,
          data: { name: 'Рекомендации E21' },
        })
      ).json();
      const event = (options) =>
        publishForBooking(owner, stack.origin, headers, { organizationId: org.id, ...options });
      const source = await event({
        title: 'Вечер джаза с саксофоном',
        description: 'Живой джазовый концерт, импровизация, пиано и саксофон.',
      });
      const jazz = await event({
        title: 'Джазовое трио: пиано и саксофон',
        description: 'Live jazz music concert, saxophone, piano and improvisation.',
      });
      const theatre = await event({
        title: 'Театральная премьера',
        description: 'Драматический спектакль по классической пьесе, актёры и театральная сцена.',
      });
      const elsewhere = await event({
        title: 'Джаз в Бельцах',
        description: 'Jazz concert with piano and saxophone.',
        city: 'Бельцы',
      });
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } }),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const url = root + '/events/' + source + '/similar?limit=2';
      const cold = await page.request.get(url);
      assert.equal(cold.status(), 200);
      assert.equal((await cold.json()).mode, 'upcoming');
      await page.goto(stack.origin + '/events/' + source);
      const section = page.getByRole('region', { name: 'Рекомендации мероприятий', exact: true });
      await expect(
        section.getByText('Пока показываем ближайшие события в этом городе.', { exact: true }),
      ).toBeVisible();
      stack.recommendations.startWorker();
      await expect
        .poll(
          async () => {
            const r = await page.request.get(url);
            if (!r.ok()) return null;
            const body = await r.json();
            return body.mode === 'similar' && body.items.length === 2
              ? body.items[0].event.id
              : null;
          },
          { timeout: 45000 },
        )
        .toBe(jazz);
      const result = await (await page.request.get(url)).json();
      assert.equal(result.items[1].event.id, theatre);
      assert.ok(result.items.every((item) => ![source, elsewhere].includes(item.event.id)));
      assert.ok(result.items.every((item) => item.reason === 'SIMILAR'));
      assert.equal(
        (await (await page.request.get(url + '&maxPriceMinor=2000')).json()).items.length,
        0,
      );
      await page.reload();
      await expect(
        section.getByRole('heading', { name: 'Похожие мероприятия', exact: true }),
      ).toBeVisible();
      await expect(section.getByRole('article').first()).toHaveAttribute(
        'aria-label',
        'Джазовое трио: пиано и саксофон',
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      const pause = await owner.request.put(
        root + '/organizations/' + org.id + '/events/' + jazz + '/availability',
        {
          headers,
          data: { paused: true, expectedVersion: 0 },
        },
      );
      assert.equal(pause.status(), 200);
      const changed = await (await page.request.get(url)).json();
      assert.ok(changed.items.every((item) => item.event.id !== jazz));
      await stack.recommendations.stopApi();
      await page.reload();
      await expect(
        page.getByRole('heading', { name: 'Вечер джаза с саксофоном', exact: true }),
      ).toBeVisible();
      await expect(
        section.getByText('Подборка временно недоступна.', { exact: true }),
      ).toBeVisible();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await stack.close();
    }
  },
);
