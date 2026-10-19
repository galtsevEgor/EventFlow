import { createHash } from 'node:crypto';
import { z } from 'zod';
import { searchChangeSchema, type SearchChange } from '@eventflow/event-contracts';
import { PermanentMessageError } from '@eventflow/messaging';
import { OpenSearch, SearchEngineError } from './opensearch';

const checkpointSchema = z.strictObject({
  index: z.string(),
  generation: z.string().min(1),
  position: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  complete: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export class IndexStore {
  readonly control;
  constructor(readonly engine: OpenSearch) {
    this.control = engine.config.SEARCH_INDEX_NAMESPACE + '-control';
  }
  async initialize() {
    await this.engine.createIndex(this.control, {
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings: {
        dynamic: 'strict',
        properties: {
          index: { type: 'keyword' },
          generation: { type: 'keyword' },
          position: { type: 'long' },
          complete: { type: 'boolean' },
          updatedAt: { type: 'date' },
        },
      },
    });
  }
  async checkpoint(index: string) {
    const generation = await this.engine.identity(index);
    try {
      const response = await this.engine.request<{ _source: unknown }>(
        '/' + this.control + '/_doc/progress',
      );
      const saved = checkpointSchema.parse(response._source);
      if (saved.index === index && saved.generation === generation) return saved;
    } catch (error) {
      if (!(error instanceof SearchEngineError) || error.status !== 404) throw error;
      await this.initialize();
    }
    return {
      index,
      generation,
      position: 0,
      complete: false,
      updatedAt: new Date(0).toISOString(),
    };
  }
  async save(index: string, position: number, complete: boolean, generation: string) {
    const state = checkpointSchema.parse({
      index,
      // Preserve the generation captured before work, even if this writer resumes late.
      generation,
      position,
      complete,
      updatedAt: new Date().toISOString(),
    });
    await this.engine.request('/' + this.control + '/_doc/progress', 'PUT', state);
  }
  async ready() {
    await this.engine.health();
    const index = await this.engine.activeIndex();
    if (!(await this.checkpoint(index)).complete)
      throw new SearchEngineError(503, 'search_warming');
  }
  async apply(index: string, input: SearchChange[]) {
    if (!input.length) return;
    const changes = input.map((change) => searchChangeSchema.parse(change));
    const hashes = changes.map((change) =>
      createHash('sha256').update(JSON.stringify(change.document)).digest('hex'),
    );
    const body =
      changes
        .flatMap((change, i) => [
          JSON.stringify({
            index: { _id: change.eventId, version: change.position, version_type: 'external' },
          }),
          JSON.stringify({
            ...(change.document ?? { id: change.eventId }),
            visible: change.document !== null,
            cityKey: change.document?.city.normalize('NFKC').toLowerCase() ?? '',
            version: change.position,
            sourceHash: hashes[i],
            indexedAt: new Date().toISOString(),
          }),
        ])
        .join('\n') + '\n';
    const result = await this.engine.request<{ items: { index: { status: number } }[] }>(
      '/' + index + '/_bulk',
      'POST',
      body,
      'application/x-ndjson',
    );
    if (!Array.isArray(result.items) || result.items.length !== changes.length)
      throw new SearchEngineError(503);
    for (const [i, item] of result.items.entries()) {
      if (item.index.status >= 200 && item.index.status < 300) continue;
      if (item.index.status !== 409) throw new SearchEngineError(item.index.status);
      const change = changes[i]!;
      const existing = await this.engine.request<{
        _source: { version: number; sourceHash: string };
      }>('/' + index + '/_doc/' + change.eventId);
      if (existing._source.version > change.position) continue;
      if (existing._source.version === change.position && existing._source.sourceHash === hashes[i])
        continue;
      throw new PermanentMessageError('Conflicting search document version');
    }
  }
}
