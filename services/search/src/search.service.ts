import { z } from 'zod';
import {
  searchDocumentSchema,
  searchPageSchema,
  type SearchQuery,
} from '@eventflow/event-contracts';
import { OpenSearch, SearchEngineError } from './opensearch';
import { IndexStore } from './index-store';

const resultSchema = z.object({
  timed_out: z.literal(false),
  _shards: z.object({ failed: z.literal(0) }),
  hits: z.object({
    total: z.object({ value: z.number().int().nonnegative(), relation: z.literal('eq') }),
    hits: z.array(z.object({ _source: searchDocumentSchema })),
  }),
  aggregations: z.object({
    cities: z.object({ buckets: z.array(z.object({ key: z.string(), doc_count: z.number() })) }),
    selected: z.object({
      min: z.object({ value: z.number().nullable() }),
      max: z.object({ value: z.number().nullable() }),
    }),
  }),
});

export function searchRequest(query: SearchQuery, suggestions = false) {
  const filter: unknown[] = [{ term: { visible: true } }, { range: { endsAt: { gt: 'now' } } }];
  if (query.from || query.to)
    filter.push({
      range: {
        localDate: { ...(query.from && { gte: query.from }), ...(query.to && { lte: query.to }) },
      },
    });
  if (query.minPriceMinor !== undefined || query.maxPriceMinor !== undefined)
    filter.push({
      range: {
        minPriceMinor: {
          ...(query.minPriceMinor !== undefined && { gte: query.minPriceMinor }),
          ...(query.maxPriceMinor !== undefined && { lte: query.maxPriceMinor }),
        },
      },
    });
  const city = query.city
    ? { term: { cityKey: query.city.normalize('NFKC').toLowerCase() } }
    : { match_all: {} };
  const text = !query.q
    ? []
    : [
        {
          multi_match: suggestions
            ? { query: query.q, fields: ['title.prefix^4', 'title^6'], operator: 'and' }
            : {
                query: query.q,
                fields: ['title^6', 'title.stemmed^3', 'description', 'description.stemmed'],
                type: 'best_fields',
                operator: 'and',
                fuzziness: 'AUTO:3,7',
                max_expansions: 25,
              },
        },
      ];
  const sort =
    query.sort === 'relevance' && query.q
      ? [{ _score: 'desc' }, { startsAt: 'asc' }, { id: 'asc' }]
      : query.sort === 'price_asc' || query.sort === 'price_desc'
        ? [
            { minPriceMinor: query.sort === 'price_asc' ? 'asc' : 'desc' },
            { startsAt: 'asc' },
            { id: 'asc' },
          ]
        : [{ startsAt: 'asc' }, { id: 'asc' }];
  return {
    timeout: '1s',
    track_total_hits: true,
    _source: Object.keys(searchDocumentSchema.shape),
    from: suggestions ? 0 : (query.page - 1) * query.pageSize,
    size: suggestions ? 6 : query.pageSize,
    query: { bool: { filter, must: text } },
    post_filter: city,
    sort: suggestions ? [{ _score: 'desc' }, { startsAt: 'asc' }, { id: 'asc' }] : sort,
    aggs: {
      cities: { terms: { field: 'city', size: 30, order: [{ _count: 'desc' }, { _key: 'asc' }] } },
      selected: {
        filter: city,
        aggs: {
          min: { min: { field: 'minPriceMinor' } },
          max: { max: { field: 'minPriceMinor' } },
        },
      },
    },
  };
}

export class SearchService {
  constructor(
    private readonly engine: OpenSearch,
    private readonly store: IndexStore,
  ) {}
  async list(query: SearchQuery, suggestions = false) {
    await this.store.ready();
    const raw = await this.engine.request(
      '/' + this.engine.alias + '/_search',
      'POST',
      searchRequest(query, suggestions),
    );
    const parsed = resultSchema.safeParse(raw);
    if (!parsed.success) throw new SearchEngineError(503, 'incomplete_search_response');
    const { hits, aggregations } = parsed.data;
    return searchPageSchema.parse({
      events: hits.hits.map((hit) => hit._source),
      total: hits.total.value,
      page: suggestions ? 1 : query.page,
      pageSize: suggestions ? 6 : query.pageSize,
      pages: Math.min(200, Math.ceil(hits.total.value / (suggestions ? 6 : query.pageSize))),
      facets: {
        cities: aggregations.cities.buckets.map((bucket) => ({
          value: bucket.key,
          count: bucket.doc_count,
        })),
        price: { min: aggregations.selected.min.value, max: aggregations.selected.max.value },
      },
      source: 'search',
      limited: false,
    });
  }
}
