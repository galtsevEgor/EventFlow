import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';
import { loginBuyer, publishForBooking } from './booking-setup.mjs';
import { readTrace, traceSpans } from '../helpers/traces.mjs';

test(
  'real local embeddings feed SSR recommendations with truthful cold fallback and immediate Catalog exclusion',
  { timeout: 240000 },
  async () => {
    const telemetryKeys = [
      'EVENTFLOW_TELEMETRY_ENABLED',
      'EVENTFLOW_ENVIRONMENT',
      'EVENTFLOW_TRACE_SAMPLE_RATIO',
    ];
    const previous = telemetryKeys.map((key) => process.env[key]);
    Object.assign(process.env, {
      EVENTFLOW_TELEMETRY_ENABLED: 'true',
      EVENTFLOW_ENVIRONMENT: 'test',
      EVENTFLOW_TRACE_SAMPLE_RATIO: '1',
    });
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
      const traceId = randomBytes(16).toString('hex');
      const traced = await page.request.get(url, {
        headers: { traceparent: '00-' + traceId + '-' + randomBytes(8).toString('hex') + '-01' },
      });
      assert.equal(traced.status(), 200);
      const trace = await readTrace(traceId, (body) => {
        const services = new Set(traceSpans(body).map((span) => span.service));
        return ['bff', 'recommendations', 'catalog'].every((service) => services.has(service));
      });
      assert.ok(traceSpans(trace).some((span) => span.name === 'recommendations.http'));
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
      await owner.goto(stack.origin + '/events/' + source);
      await owner.getByRole('button', { name: 'В избранное', exact: true }).click();
      await expect(
        owner.getByRole('button', { name: 'Убрать из избранного', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
      await owner.goto(stack.origin + '/recommendations');
      await owner.getByRole('checkbox', { name: 'Джаз', exact: true }).check();
      await owner.getByRole('button', { name: 'Сохранить интересы', exact: true }).click();
      await expect(owner.getByText('Интересы сохранены.', { exact: true })).toBeVisible();
      await owner.getByLabel('Город', { exact: true }).fill('Кишинёв');
      await owner.getByRole('button', { name: 'Применить фильтры', exact: true }).click();
      await expect(owner.getByRole('article').first()).toHaveAttribute(
        'aria-label',
        'Джазовое трио: пиано и саксофон',
      );
      await expect(owner.getByText('С учётом избранного').first()).toBeVisible();
      const privateProfile = await owner.request.get(root + '/recommendations/profile');
      assert.equal(privateProfile.status(), 200);
      assert.equal(privateProfile.headers()['cache-control'], 'no-store');
      assert.deepEqual((await privateProfile.json()).interests, ['jazz']);
      assert.equal((await page.request.get(root + '/recommendations/profile')).status(), 401);
      assert.equal(
        (
          await owner.request.put(root + '/recommendations/profile', {
            data: { revision: 0, interests: ['rock'] },
          })
        ).status(),
        403,
      );
      const stale = await owner.request.put(root + '/recommendations/profile', {
        headers,
        data: { revision: 0, interests: ['rock'] },
      });
      assert.equal(stale.status(), 409);
      await owner.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await owner.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await owner.getByLabel('Город', { exact: true }).fill('Бельцы');
      await owner.getByRole('button', { name: 'Применить фильтры', exact: true }).click();
      await expect(owner.getByRole('article')).toHaveCount(1);
      await expect(owner.getByRole('article').first()).toHaveAttribute(
        'aria-label',
        'Джаз в Бельцах',
      );
      await owner.reload();
      await expect(owner.getByLabel('Город', { exact: true })).toHaveValue('Бельцы');
      await expect(owner.getByRole('checkbox', { name: 'Джаз', exact: true })).toBeChecked();
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
      await owner.request.put(root + '/recommendations/favorites/' + theatre, { headers });
      const pauseTheatre = await owner.request.put(
        root + '/organizations/' + org.id + '/events/' + theatre + '/availability',
        { headers, data: { paused: true, expectedVersion: 0 } },
      );
      assert.equal(pauseTheatre.status(), 200);
      await owner.reload();
      await expect(owner.getByText('Мероприятие больше недоступно', { exact: true })).toBeVisible();
      await owner
        .getByRole('button', {
          name: 'Удалить из избранного: недоступное мероприятие',
          exact: true,
        })
        .click();
      await expect(owner.getByText('Мероприятие больше недоступно', { exact: true })).toHaveCount(
        0,
      );
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
      telemetryKeys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  },
);
