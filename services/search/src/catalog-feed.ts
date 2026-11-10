import { z } from 'zod';
import {
  MAX_SEARCH_FEED_BATCH_SIZE,
  MAX_SEARCH_RECONCILE_BATCH_SIZE,
  searchFeedSchema,
} from '@eventflow/event-contracts';
import type { ClientCredentials } from '@eventflow/service-runtime';

const MAX_CATALOG_RECONCILE_PAGES = 10_000;

export class CatalogFeed {
  constructor(
    private readonly origin: string,
    private readonly credentials: Pick<ClientCredentials, 'token'>,
  ) {}
  private async request(path: string, body?: unknown) {
    const response = await fetch(new URL(path, this.origin), {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: {
        authorization: 'Bearer ' + (await this.credentials.token()),
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Catalog search feed unavailable');
    }
    return response.json();
  }
  async read(after: number, through?: number) {
    const params = new URLSearchParams({
      after: String(after),
      limit: String(MAX_SEARCH_FEED_BATCH_SIZE),
      ...(through === undefined ? {} : { through: String(through) }),
    });
    const page = searchFeedSchema.parse(await this.request('/internal/search/changes?' + params));
    let previous = after;
    for (const change of page.changes) {
      if (change.position <= previous || change.position > page.through)
        throw new Error('Invalid feed order');
      previous = change.position;
    }
    if (
      page.next !== previous ||
      (!page.changes.length && after < page.through) ||
      page.next > page.through
    )
      throw new Error('Invalid feed cursor');
    return page;
  }
  async reconcile() {
    let after: string | null = null;
    for (let page = 0; page < MAX_CATALOG_RECONCILE_PAGES; page++) {
      const result = z.strictObject({ next: z.uuid().nullable() }).parse(
        await this.request('/internal/search/reconcile', {
          ...(after ? { after } : {}),
          limit: MAX_SEARCH_RECONCILE_BATCH_SIZE,
        }),
      );
      if (!result.next) return;
      if (after && result.next <= after) throw new Error('Invalid reconcile cursor');
      after = result.next;
    }
    throw new Error('Catalog reconciliation limit reached');
  }
}
