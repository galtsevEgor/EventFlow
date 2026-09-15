import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { publishForBooking } from '../e2e/booking-setup.mjs';

const [action, name] = process.argv.slice(2);
const port = { staging: 28000, recovery: 48000, cluster: 58000 }[name];
if (
  !port ||
  !['seed', 'mark', 'verify'].includes(action) ||
  (action === 'seed' && name === 'recovery') ||
  (action === 'mark' && name !== 'staging')
)
  throw new Error('Use seed staging|cluster | mark staging | verify staging|recovery|cluster.');
const origin = `http://127.0.0.1:${port}`;
const root = origin + '/api/v1';
const evidence = name === 'cluster' ? 'work/e7/acceptance.json' : 'work/release/acceptance.json';
const users =
  name === 'cluster'
    ? 'work/e7/credentials/demo-users.json'
    : `work/release/${name}/work/local/demo-users.json`;
const [owner] = JSON.parse(readFileSync(users, 'utf8'));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(origin + '/api/v1/auth/login?returnTo=%2Forders');
  await page.locator('input[name=username]').fill(owner.email);
  await page.locator('input[name=password]').fill(owner.password);
  await page.locator('#kc-login').click();
  await expect(page.getByRole('heading', { name: 'Мои заказы' })).toBeVisible({ timeout: 15000 });
  const session = await (await page.request.get(root + '/auth/session')).json();
  assert.ok(session.user?.email === owner.email);
  const headers = { origin, 'x-csrf-token': session.csrfToken };
  async function digest(url) {
    const response = await page.request.get(url);
    assert.equal(response.status(), 200);
    return createHash('sha256')
      .update(await response.body())
      .digest('hex');
  }
  if (action === 'seed') {
    const saleId = await publishForBooking(page, origin, headers, { title: 'Приёмка EventFlow' });
    const reservation = await page.request.post(root + '/orders', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { saleId, seatIds: ['r1-s1'] },
    });
    assert.equal(reservation.status(), 201);
    const { id: orderId } = await reservation.json();
    await page.goto(origin + '/orders/' + orderId);
    await page.getByRole('button', { name: 'Перейти к оплате', exact: true }).click();
    await expect(page.getByText('Демо-режим · без списания денег')).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: /^Оплатить .* в демо$/ }).click();
    await expect(page.getByRole('button', { name: /^Показать QR/ })).toBeVisible({
      timeout: 20000,
    });
    const list = root + `/orders/${orderId}/tickets`;
    const {
      tickets: [{ id: ticketId }],
    } = await (await page.request.get(list)).json();
    const { coverId } = await (await page.request.get(root + '/events/' + saleId)).json();
    assert.ok(coverId);
    const qr = await digest(list + `/${ticketId}/qr`);
    const cover = await digest(root + '/covers/' + coverId);
    writeFileSync(evidence, JSON.stringify({ saleId, orderId, ticketId, coverId, qr, cover }));
    console.log('Synthetic booking, fake payment, ticket and cover verified');
  } else if (action === 'mark') {
    const data = JSON.parse(readFileSync(evidence, 'utf8'));
    const marker = await page.request.post(root + '/organizations', {
      headers,
      data: { name: 'После точки восстановления' },
    });
    assert.equal(marker.status(), 201);
    data.marker = (await marker.json()).id;
    const confirmed = await page.request.get(root + '/organizations/' + data.marker);
    assert.equal(confirmed.status(), 200);
    writeFileSync(evidence, JSON.stringify(data));
    console.log('Post-backup marker created and verified on staging');
  } else {
    const { saleId, orderId, ticketId, coverId, qr, cover, marker } = JSON.parse(
      readFileSync(evidence, 'utf8'),
    );
    const event = await page.request.get(root + '/events/' + saleId);
    const order = await page.request.get(root + '/orders/' + orderId);
    assert.equal(event.status(), 200);
    assert.equal(order.status(), 200);
    assert.equal((await order.json()).state, 'CONFIRMED');
    assert.ok((await digest(root + `/orders/${orderId}/tickets/${ticketId}/qr`)) === qr);
    assert.ok((await digest(root + '/covers/' + coverId)) === cover);
    if (name === 'recovery' && marker) {
      assert.equal((await page.request.get(root + '/organizations/' + marker)).status(), 404);
      const path = 'work/release/recovery/restore.json';
      const metrics = JSON.parse(readFileSync(path, 'utf8'));
      metrics.businessRtoMs = Date.now() - Date.parse(metrics.restoreStartedAt);
      writeFileSync(path, JSON.stringify(metrics, null, 2) + '\n');
      console.log(JSON.stringify(metrics));
    }
    console.log('Identity, public catalog, confirmed order, original QR and cover verified');
  }
} finally {
  await browser.close();
}
