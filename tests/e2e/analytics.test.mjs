import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';
import { loginBuyer, publishForBooking } from './booking-setup.mjs';

test(
  'real storefront collection survives lost ACK and produces a paid funnel and accessible organizer report',
  { timeout: 240000 },
  async () => {
    const stack = await fullStack({ booking: true, payments: true, search: true, analytics: true }),
      browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const headers = await loginBuyer(page, stack.origin),
        id = await publishForBooking(page, stack.origin, headers);
      const event = await (await page.request.get(stack.origin + '/api/v1/events/' + id)).json();
      await expect
        .poll(
          async () => {
            const r = await page.request.get(
              stack.origin + '/api/v1/search/events?q=' + encodeURIComponent(event.title),
            );
            return r.ok() && (await r.json()).events.some((e) => e.id === id);
          },
          { timeout: 30000 },
        )
        .toBe(true);
      let lost = false;
      await page.route('**/api/v1/analytics/events', async (route) => {
        if (!lost) {
          lost = true;
          const accepted = await route.fetch();
          assert.equal(accepted.status(), 202, await accepted.text());
          await route.abort('failed');
        } else await route.continue();
      });
      await page.goto(stack.origin + '/?q=' + encodeURIComponent(event.title));
      const card = page.locator('[data-analytics-event="' + id + '"]');
      await expect(card).toBeVisible();
      await card.scrollIntoViewIfNeeded();
      await expect
        .poll(async () =>
          Number(
            (
              await stack.analytics.journal.pool.query(
                "SELECT count(*) AS n FROM analytics_event WHERE fact->>'kind'='impression' AND fact->>'eventId'=$1",
                [id],
              )
            ).rows[0].n,
          ),
        )
        .toBe(1);
      await page.reload();
      await expect(card).toBeVisible();
      await card.scrollIntoViewIfNeeded();
      await card.getByRole('link').click();
      await expect
        .poll(async () =>
          Number(
            (
              await stack.analytics.journal.pool.query(
                "SELECT count(*) AS n FROM analytics_event WHERE fact->>'kind'='event_view' AND fact->>'eventId'=$1",
                [id],
              )
            ).rows[0].n,
          ),
        )
        .toBeGreaterThan(0);
      const cookie = (await page.context().cookies()).find((c) => c.name === 'eventflow_analytics');
      assert.equal(cookie.httpOnly, true);
      const bad = await page.request.post(stack.origin + '/api/v1/analytics/events', {
        headers: { origin: stack.origin },
        data: {
          events: [
            {
              id: randomUUID(),
              kind: 'confirmed',
              eventId: id,
              source: 'direct',
              occurredAt: new Date().toISOString(),
            },
          ],
        },
      });
      assert.equal(bad.status(), 422);
      const reserve = await page.request.post(stack.origin + '/api/v1/orders', {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: { saleId: id, seatIds: ['r1-s1'] },
      });
      assert.equal(reserve.status(), 201);
      const order = await reserve.json();
      const booking = await stack.startBooking();
      assert.ok(
        (await booking.db.order.findUnique({ where: { id: order.id } })).analyticsSessionId,
      );
      const attempt = await page.request.post(
        stack.origin + '/api/v1/orders/' + order.id + '/payment-attempt',
        { headers: { ...headers, 'idempotency-key': randomUUID() }, data: {} },
      );
      assert.equal(attempt.status(), 202);
      await page.goto(stack.origin + '/orders/' + order.id);
      await expect(page.getByText('Демо-режим · без списания денег')).toBeVisible({
        timeout: 15000,
      });
      const confirmed = await page.request.post(
        stack.origin + '/api/v1/orders/' + order.id + '/payment-attempt/fake-confirm',
        { headers, data: { outcome: 'success' } },
      );
      assert.ok([200, 202].includes(confirmed.status()), await confirmed.text());
      const date = new Date().toISOString().slice(0, 10),
        organizationId = (await booking.db.order.findUnique({ where: { id: order.id } }))
          .organizationId;
      const url =
        stack.origin +
        '/api/v1/organizations/' +
        organizationId +
        '/analytics?from=' +
        date +
        '&to=' +
        date;
      await expect
        .poll(
          async () => {
            const r = await page.request.get(url);
            return r.ok() ? (await r.json()).current.confirmed : 0;
          },
          { timeout: 30000 },
        )
        .toBe(1);
      const stats = await (await page.request.get(url)).json();
      assert.equal(stats.current.impressions, 1);
      assert.equal(stats.current.views, 1);
      assert.equal(stats.current.held, 1);
      assert.equal(stats.current.conversion, 1);
      assert.equal(stats.current.ctr, 1);
      assert.equal(
        (
          await page.request.get(
            stack.origin + '/api/v1/analytics/search-quality?from=' + date + '&to=' + date,
          )
        ).status(),
        403,
      );
      await page.goto(stack.origin + '/organizer/?org=' + organizationId);
      mkdirSync('work/e18', { recursive: true });
      await page.screenshot({ path: 'work/e18/organizer-entry.png', fullPage: true });
      await page.getByRole('button', { name: 'Аналитика продукта', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Продуктовая аналитика' })).toBeVisible();
      await expect(page.getByText('Данные обновлены.', { exact: false })).toBeVisible();
      await page.getByText('Данные графика', { exact: true }).click();
      await expect(page.getByRole('table')).toBeVisible();
      mkdirSync('work/e18', { recursive: true });
      await page.screenshot({ path: 'work/e18/analytics-desktop.png', fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: 'work/e18/analytics-mobile.png', fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.getByLabel('Аналитика с').fill('2026-01-01');
      await expect(page.getByRole('alert').filter({ hasText: 'период до 31 дня' })).toBeVisible();
      mkdirSync('work/e18', { recursive: true });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await stack.close();
    }
  },
);
