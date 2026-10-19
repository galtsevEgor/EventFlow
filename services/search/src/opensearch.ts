import type { SearchConfig } from './config';
import { searchMapping } from './mapping';

export class SearchEngineError extends Error {
  constructor(
    readonly status: number,
    readonly code = 'search_engine_unavailable',
  ) {
    super('Search engine request failed');
  }
}
export class OpenSearch {
  readonly alias;
  constructor(readonly config: SearchConfig) {
    this.alias = config.SEARCH_INDEX_NAMESPACE + '-events';
  }
  async request<T = Record<string, unknown>>(
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.config.OPENSEARCH_URL), {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new SearchEngineError(503);
    }
    const data = await response.json().catch(() => null);
    if (!response.ok)
      throw new SearchEngineError(
        response.status,
        typeof data?.error?.type === 'string' ? data.error.type : undefined,
      );
    return data as T;
  }
  async health() {
    const state = await this.request<{ status: string }>('/_cluster/health');
    if (!['yellow', 'green'].includes(state.status)) throw new SearchEngineError(503);
  }
  async activeIndex() {
    const aliases = await this.request<Record<string, unknown>>('/_alias/' + this.alias);
    const indexes = Object.keys(aliases);
    if (indexes.length !== 1 || !indexes[0]!.startsWith(this.alias + '-'))
      throw new SearchEngineError(503, 'invalid_search_alias');
    return indexes[0]!;
  }
  async ensure() {
    await this.health();
    try {
      return await this.activeIndex();
    } catch (error) {
      if (!(error instanceof SearchEngineError) || error.status !== 404) throw error;
    }
    const index = this.alias + '-v1';
    try {
      await this.request('/' + index, 'PUT', searchMapping);
    } catch (error) {
      if (
        !(error instanceof SearchEngineError) ||
        error.code !== 'resource_already_exists_exception'
      )
        throw error;
    }
    await this.request('/_aliases', 'POST', { actions: [{ add: { index, alias: this.alias } }] });
    return this.activeIndex();
  }
}
