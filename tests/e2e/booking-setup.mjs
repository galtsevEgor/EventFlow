import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';

export async function loginBuyer(page, origin) {
  const user = JSON.parse(readFileSync('work/local/demo-users.json', 'utf8')).find(
    (user) => user.username === 'owner',
  );
  await page.goto(origin + '/api/v1/auth/login?returnTo=%2Forders');
  await page.locator('input[name=username]').fill(user.email);
  await page.locator('input[name=password]').fill(user.password);
  await page.locator('#kc-login').click();
  await expect(page.getByRole('heading', { name: 'Мои заказы' })).toBeVisible();
  const session = await (await page.request.get(origin + '/api/v1/auth/session')).json();
  return { origin, 'x-csrf-token': session.csrfToken };
}

export async function publishForBooking(page, origin, headers) {
  const org = await (
    await page.request.post(origin + '/api/v1/organizations', {
      headers,
      data: { name: 'Booking concert' },
    })
  ).json();
  const draft = await (
    await page.request.post(`${origin}/api/v1/organizations/${org.id}/events`, {
      headers,
      data: { title: 'Вечер музыки', description: 'Концерт для проверки бронирования.' },
    })
  ).json();
  const path = `${origin}/api/v1/organizations/${org.id}/events/${draft.id}`;
  const response = await page.request.put(path + '/configuration', {
    headers,
    data: {
      revision: 0,
      configuration: {
        city: 'Кишинёв',
        address: 'Улица Музыки, 12',
        timeZone: 'Europe/Chisinau',
        startsAt: '2035-06-01T16:00:00Z',
        endsAt: '2035-06-01T18:00:00Z',
        salesStartsAt: '2020-01-01T00:00:00Z',
        salesEndsAt: '2035-06-01T15:30:00Z',
        admissionStartsAt: '2035-06-01T15:00:00Z',
        admissionEndsAt: '2035-06-01T18:00:00Z',
        currency: 'EUR',
        categories: [{ id: 'standard', name: 'Стандарт', priceMinor: 2500 }],
        layout: { rows: 4, columns: 8, defaultCategoryId: 'standard', overrides: [] },
      },
    },
  });
  assert.equal(response.status(), 200);
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 400;
    const context = canvas.getContext('2d');
    context.fillStyle = '#285a45';
    context.fillRect(0, 0, 600, 400);
    context.fillStyle = '#faf6e4';
    context.font = '44px Arial';
    context.fillText('EVENTFLOW / LIVE', 50, 220);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const cover = await page.request.post(path + '/cover', {
    headers,
    multipart: {
      file: { name: 'poster.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') },
    },
  });
  assert.equal(cover.status(), 201);
  const publication = await page.request.post(path + '/publication', {
    headers,
    data: { revision: (await cover.json()).revision },
  });
  assert.equal(publication.status(), 201);
  await expect
    .poll(async () => (await page.request.get(`${origin}/api/v1/events/${draft.id}`)).status())
    .toBe(200);
  return draft.id;
}
