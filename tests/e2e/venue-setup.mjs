import assert from 'node:assert/strict';
import { createGridMap } from '../../packages/seat-map/dist/index.js';

export async function venueDraft(
  page,
  origin,
  headers,
  { rows = 2, columns = 3, withMap = false } = {},
) {
  const created = await page.request.post(origin + '/api/v1/organizations', {
    headers,
    data: { name: 'Команда конструктора' },
  });
  assert.equal(created.status(), 201);
  const organizationId = (await created.json()).id;
  const response = await page.request.post(
    `${origin}/api/v1/organizations/${organizationId}/events`,
    { headers, data: { title: 'Зал EventFlow', description: 'Концерт с интерактивной схемой.' } },
  );
  assert.equal(response.status(), 201);
  const id = (await response.json()).id,
    path = `/api/v1/organizations/${organizationId}/events/${id}`;
  const configuration = {
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
    categories: [
      { id: 'standard', name: 'Партер', priceMinor: 2500 },
      { id: 'vip', name: 'Балкон', priceMinor: 3500 },
    ],
    layout: {
      rows,
      columns,
      defaultCategoryId: 'standard',
      overrides: [],
      ...(withMap ? { map: createGridMap(rows, columns) } : {}),
    },
  };
  const configured = await page.request.put(origin + path + '/configuration', {
    headers,
    data: { revision: 0, configuration },
  });
  assert.equal(configured.status(), 200);
  return { organizationId, id, path, configuration };
}
export const webglArgs = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
];
