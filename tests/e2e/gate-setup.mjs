import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
export async function gate(page, origin, org, event) {
  await page.goto(origin + '/organizer/gate/?org=' + org + '&event=' + event);
  await page.getByRole('button', { name: 'Подготовить мероприятие', exact: true }).click();
  await expect(page.getByText(/В снимке:/)).toBeVisible();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await expect(page.getByLabel('Код билета', { exact: true })).toBeEnabled();
}
export async function scan(page, credential) {
  await page.getByLabel('Код билета', { exact: true }).fill(credential);
  await page.getByRole('button', { name: 'Сохранить проверку', exact: true }).click();
}
export async function localRows(page, store = 'scans') {
  return page.evaluate(async (name) => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('eventflow-gate');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const r = db.transaction(name).objectStore(name).getAll();
        r.onsuccess = () =>
          resolve(
            name === 'vaults'
              ? r.result.map((v) => ({ id: v.id, extractable: v.key.extractable }))
              : r.result,
          );
        r.onerror = () => reject(r.error);
      });
    } finally {
      db.close();
    }
  }, store);
}
export async function virtualCamera(page, image) {
  await page.evaluate(async (data) => {
    const qr = new Image();
    qr.src = 'data:image/png;base64,' + data;
    await qr.decode();
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 360;
        const context = canvas.getContext('2d');
        context.fillStyle = 'white';
        context.fillRect(0, 0, 360, 360);
        const stream = canvas.captureStream(12);
        const [track] = stream.getVideoTracks();
        const timer = setInterval(() => {
          if (track.readyState === 'ended') clearInterval(timer);
          else context.drawImage(qr, 32, 32, qr.width, qr.height);
        }, 70);
        return stream;
      },
    });
  }, image.toString('base64'));
}

export async function purchase(page, origin, headers, event, seatIds) {
  const root = origin + '/api/v1',
    r = await page.request.post(root + '/orders', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { saleId: event, seatIds },
    });
  assert.equal(r.status(), 201);
  const order = await r.json();
  assert.equal(
    (
      await page.request.post(root + '/orders/' + order.id + '/payment-attempt', {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: {},
      })
    ).status(),
    202,
  );
  await page.goto(origin + '/orders/' + order.id);
  await expect(page.getByText('Демо-режим · без списания денег')).toBeVisible({ timeout: 15000 });
  assert.ok(
    [200, 202].includes(
      (
        await page.request.post(root + '/orders/' + order.id + '/payment-attempt/fake-confirm', {
          headers,
          data: { outcome: 'success' },
        })
      ).status(),
    ),
  );
  await expect
    .poll(async () => {
      const response = await page.request.get(root + '/orders/' + order.id + '/tickets');
      return response.ok() ? (await response.json()).tickets.length : 0;
    })
    .toBe(seatIds.length);
  return order;
}
