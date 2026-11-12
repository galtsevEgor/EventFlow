import { createApiClient, unwrap } from '@eventflow/api-client';
import type { Search } from './catalog-api';

const SEARCH_REQUEST_TIMEOUT_MS = 6_000;

export class SearchInputError extends Error {}
export function priceMinor(value: string | string[] | undefined) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{1,7}(?:[.,]\d{1,2})?$/.test(value))
    throw new SearchInputError('Введите цену в евро, с точностью до цента.');
  const [whole, fraction = ''] = value.replace(',', '.').split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (minor > 100_000_000) throw new SearchInputError('Цена не должна превышать 1 000 000 €.');
  return minor;
}
export async function searchEvents(search: Search) {
  const keys = ['q', 'city', 'from', 'to', 'page', 'pageSize', 'sort', 'minPrice', 'maxPrice'];
  for (const key of keys)
    if (Array.isArray(search[key])) throw new SearchInputError('Укажите каждый фильтр один раз.');
  const text = (key: string) => (typeof search[key] === 'string' ? search[key] : '');
  const { client } = createApiClient(process.env.BFF_URL ?? 'http://127.0.0.1:4000');
  const sort = text('sort') || (text('q') ? 'relevance' : 'date');
  const minPriceMinor = priceMinor(search.minPrice),
    maxPriceMinor = priceMinor(search.maxPrice);
  if (!['relevance', 'date', 'price_asc', 'price_desc'].includes(sort))
    throw new SearchInputError('Выберите порядок сортировки из списка.');
  return unwrap(
    await client.GET('/api/v1/search/events', {
      cache: 'no-store',
      signal: AbortSignal.timeout(SEARCH_REQUEST_TIMEOUT_MS),
      params: {
        query: {
          q: text('q'),
          city: text('city'),
          ...(text('from') && { from: text('from') }),
          ...(text('to') && { to: text('to') }),
          ...(minPriceMinor !== undefined && { minPriceMinor }),
          ...(maxPriceMinor !== undefined && { maxPriceMinor }),
          page: Number(text('page') || 1),
          pageSize: Number(text('pageSize') || 12),
          sort: sort as 'relevance' | 'date' | 'price_asc' | 'price_desc',
        },
      },
    }),
  );
}
