import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';

test(
  'anonymous visitors browse server-rendered events with URL filters, pagination, SEO and live sale state',
  { timeout: 120000 },
  async () => {
    const stack = await fullStack({ booking: true });
    const browser = await chromium.launch();
    try {
      const owner = JSON.parse(readFileSync('work/local/demo-users.json', 'utf8')).find(
        (user) => user.username === 'owner',
      );
      const page = await browser.newPage();
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
          data: { name: 'Сцена EventFlow' },
        })
      ).json();
      const events = [];
      for (const [title, city, color, word] of [
        ['Концерт в саду', 'Кишинёв', '#285a45', 'GARDEN'],
        ['Джаз на закате', 'Кишинёв', '#9b563a', 'JAZZ'],
        ['Встреча с музыкой', 'Бельцы', '#394b76', 'LIVE'],
      ]) {
        const draft = await (
          await page.request.post(`${stack.origin}/api/v1/organizations/${org.id}/events`, {
            headers,
            data: {
              title,
              description:
                'Живая музыка летним вечером.\n<script>window.untrustedExecuted=true</script>',
            },
          })
        ).json();
        const path = `${stack.origin}/api/v1/organizations/${org.id}/events/${draft.id}`;
        const config = await page.request.put(path + '/configuration', {
          headers,
          data: {
            revision: 0,
            configuration: {
              city,
              address: 'Улица Музыки, 12',
              timeZone: 'Europe/Chisinau',
              startsAt: '2035-06-01T16:00:00Z',
              endsAt: '2035-06-01T18:00:00Z',
              salesStartsAt: '2020-01-01T09:00:00Z',
              salesEndsAt: '2035-06-01T15:30:00Z',
              admissionStartsAt: '2035-06-01T15:00:00Z',
              admissionEndsAt: '2035-06-01T18:00:00Z',
              currency: 'EUR',
              categories: [{ id: 'standard', name: 'Стандарт', priceMinor: 2500 }],
              layout: { rows: 2, columns: 3, defaultCategoryId: 'standard', overrides: [] },
            },
          },
        });
        assert.equal(config.status(), 200);
        const png = await page.evaluate(
          ({ color, word }) => {
            const canvas = document.createElement('canvas');
            canvas.width = 1000;
            canvas.height = 650;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 1000, 650);
            ctx.strokeStyle = '#e4deab';
            ctx.lineWidth = 3;
            for (let i = 0; i < 8; i++) {
              ctx.beginPath();
              ctx.arc(760, 300, 80 + i * 37, 0, Math.PI * 2);
              ctx.stroke();
            }
            ctx.fillStyle = '#faf6e4';
            ctx.font = 'bold 120px Arial';
            ctx.fillText(word, 65, 360);
            ctx.font = '28px Arial';
            ctx.fillText('EVENTFLOW / SUMMER 2035', 65, 550);
            return canvas.toDataURL('image/png').split(',')[1];
          },
          { color, word },
        );
        const cover = await page.request.post(path + '/cover', {
          headers,
          multipart: {
            file: { name: 'poster.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') },
          },
        });
        assert.equal(cover.status(), 201);
        const publish = await page.request.post(path + '/publication', {
          headers,
          data: { revision: (await cover.json()).revision },
        });
        assert.equal(publish.status(), 201);
        events.push({ id: draft.id, path });
      }
      const visitor = await browser.newPage({ viewport: { width: 1360, height: 1100 } });
      await expect
        .poll(
          async () =>
            (await (await visitor.request.get(stack.origin + '/api/v1/events')).json()).total,
        )
        .toBe(3);
      await visitor.goto(stack.origin + '/');
      await expect(visitor.getByRole('link', { name: /Концерт в саду/ })).toBeVisible();
      await expect(visitor.getByRole('link', { name: 'Войти', exact: true })).toBeVisible();
      const html = await (await visitor.request.get(stack.origin + '/')).text();
      assert.match(html, /Концерт в саду/);
      assert.doesNotMatch(html, /owner@eventflow.test/);
      mkdirSync('work/e2', { recursive: true });
      await expect
        .poll(() =>
          visitor
            .locator('.event-link img')
            .evaluateAll((images) =>
              images.every((image) => image.complete && image.naturalWidth > 0),
            ),
        )
        .toBe(true);
      await visitor.screenshot({ path: 'work/e2/catalog-desktop.png', fullPage: true });
      await visitor.getByLabel('Название', { exact: true }).fill('концерт');
      await visitor.getByLabel('Город', { exact: true }).fill('Кишинёв');
      await visitor.getByLabel('С даты').fill('2035-06-01');
      await visitor.getByLabel('По дату').fill('2035-06-01');
      await visitor.getByRole('button', { name: 'Найти события' }).click();
      await expect(visitor.locator('.public-event-card')).toHaveCount(1);
      assert.equal(new URL(visitor.url()).searchParams.get('city'), 'Кишинёв');
      await visitor.reload();
      await expect(visitor.getByLabel('Город', { exact: true })).toHaveValue('Кишинёв');
      await visitor.goto(stack.origin + '/?city=' + encodeURIComponent('Кишинёв') + '&pageSize=1');
      const first = await visitor.locator('.event-link').getAttribute('href');
      await visitor.getByRole('link', { name: 'Следующая →' }).click();
      await expect(visitor.getByText('Страница 2 из 2')).toBeVisible();
      assert.notEqual(await visitor.locator('.event-link').getAttribute('href'), first);
      await visitor.goto(stack.origin + '/?q=несуществующее');
      await expect(visitor.getByText('Мероприятий не найдено', { exact: true })).toBeVisible();
      await visitor.goto(`${stack.origin}/events/${events[0].id}`);
      const availability = await visitor.request.get(
        `${stack.origin}/api/v1/sales/${events[0].id}`,
      );
      assert.equal(availability.status(), 200, JSON.stringify(await availability.json()));
      await expect(
        visitor.getByRole('heading', { name: 'Концерт в саду', exact: true }),
      ).toBeVisible();
      await expect(visitor.getByText('Продажи открыты', { exact: true })).toBeVisible();
      await expect(visitor).toHaveTitle('Концерт в саду — EventFlow');
      assert.equal(await visitor.evaluate(() => window.untrustedExecuted), undefined);
      const structured = JSON.parse(
        await visitor.locator('script[type="application/ld+json"]').textContent(),
      );
      assert.equal(structured.name, 'Концерт в саду');
      assert.equal(structured['@type'], 'Event');
      assert.match(
        await visitor.locator('link[rel=canonical]').getAttribute('href'),
        new RegExp(events[0].id),
      );
      const sale = await visitor.request.get(`${stack.origin}/api/v1/sales/${events[0].id}`);
      assert.equal(sale.headers()['cache-control'], 'no-store');
      assert.equal((await sale.json()).seats.length, 6);
      await visitor.screenshot({ path: 'work/e2/event-desktop.png', fullPage: true });
      await page.request.put(events[0].path + '/availability', {
        headers,
        data: { paused: true, expectedVersion: 0 },
      });
      await expect(visitor.getByText('Продажи приостановлены', { exact: true })).toBeVisible({
        timeout: 15000,
      });
      await visitor.setViewportSize({ width: 390, height: 844 });
      assert.ok(await visitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await visitor.screenshot({ path: 'work/e2/event-mobile.png', fullPage: true });
      await visitor.goto(stack.origin + '/');
      assert.ok(await visitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await visitor.screenshot({ path: 'work/e2/catalog-mobile.png', fullPage: true });
      assert.equal(
        (
          await visitor.request.get(stack.origin + '/events/00000000-0000-0000-0000-000000000000')
        ).status(),
        404,
      );
    } finally {
      await browser.close();
      await stack.close();
    }
  },
);
