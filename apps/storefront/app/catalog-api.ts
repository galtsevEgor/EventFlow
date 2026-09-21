import { cache } from 'react';
import { notFound } from 'next/navigation';
import { createApiClient, unwrap } from '@eventflow/api-client';

export type Search = Record<string, string | string[] | undefined>;
export const filterKeys = ['q', 'city', 'from', 'to', 'page', 'pageSize'] as const;
function client() {
  return createApiClient(process.env.CATALOG_URL ?? 'http://127.0.0.1:4001').client;
}
export async function listEvents(search: Search) {
  for (const key of filterKeys)
    if (Array.isArray(search[key])) throw new Error('Укажите каждое значение фильтра один раз.');
  const text = (key: string) => (typeof search[key] === 'string' ? search[key] : '');
  return unwrap(
    await client().GET('/api/v1/events', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
      params: {
        query: {
          q: text('q'),
          city: text('city'),
          ...(text('from') ? { from: text('from') } : {}),
          ...(text('to') ? { to: text('to') } : {}),
          page: Number(text('page') || 1),
          pageSize: Number(text('pageSize') || 12),
        },
      },
    }),
  );
}
export const getEvent = cache(async (id: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const result = await client().GET('/api/v1/events/{id}', {
    params: { path: { id } },
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (result.response.status === 404 || result.response.status === 422) notFound();
  return unwrap(result);
});
export function pageLink(search: Search, page: number) {
  const params = new URLSearchParams();
  for (const key of filterKeys)
    if (key !== 'page' && typeof search[key] === 'string' && search[key])
      params.set(key, search[key]);
  if (page > 1) params.set('page', String(page));
  return `/?${params}`;
}
