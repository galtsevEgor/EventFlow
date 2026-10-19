import { expect, it } from 'vitest';
import { searchQuerySchema, searchChangeSchema } from '../src/search';

it('bounds query work, rejects private fields and enforces coherent date and price ranges', () => {
  expect(searchQuerySchema.parse({ q: ' джас ' }).q).toBe('джас');
  for (const query of [
    { page: 201 },
    { pageSize: 49 },
    { q: 'x'.repeat(161) },
    { from: '2035-06-02', to: '2035-06-01' },
    { minPriceMinor: 200, maxPriceMinor: 100 },
    { organizationId: 'private' },
    { sort: '_script' },
  ])
    expect(searchQuerySchema.safeParse(query).success).toBe(false);
});
it('requires safe monotonic versions and permits durable tombstones', () => {
  const eventId = '11111111-1111-4111-8111-111111111111';
  expect(searchChangeSchema.parse({ position: 1, eventId, document: null }).document).toBeNull();
  expect(
    searchChangeSchema.safeParse({ position: Number.MAX_SAFE_INTEGER + 1, eventId, document: null })
      .success,
  ).toBe(false);
  expect(
    searchChangeSchema.safeParse({ position: 1, eventId, document: null, token: 'private' })
      .success,
  ).toBe(false);
});
