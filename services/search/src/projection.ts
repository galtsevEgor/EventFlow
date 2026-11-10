import { searchChangeSchema, type EventEnvelope } from '@eventflow/event-contracts';
import { PermanentMessageError } from '@eventflow/messaging';
import { OpenSearch, SearchEngineError } from './opensearch';
import { IndexStore } from './index-store';
import { ProjectionLease } from './lease';
import { CatalogFeed } from './catalog-feed';

export class SearchProjection {
  private initialized = false;
  private reconciled = false;
  constructor(
    readonly engine: OpenSearch,
    readonly store: IndexStore,
    readonly lease: ProjectionLease,
    readonly feed: CatalogFeed,
  ) {}
  async project(event: EventEnvelope) {
    const result = searchChangeSchema.safeParse(event.data);
    if (
      event.producer !== 'catalog' ||
      event.eventType !== 'SearchDocumentChanged.v1' ||
      !result.success ||
      result.data.eventId !== event.aggregateId ||
      result.data.position !== event.aggregateVersion
    )
      throw new PermanentMessageError('Invalid search notification');
    if (!this.initialized) throw new Error('Search is warming');
    await this.lease.run(async (lease) => {
      const index = await this.engine.activeIndex();
      await lease.assert();
      await this.store.apply(index, [result.data]);
      await lease.assert();
    });
  }
  async sync() {
    try {
      return await this.syncCurrent();
    } catch (error) {
      if (error instanceof SearchEngineError && error.status === 404) {
        this.initialized = false;
        this.reconciled = false;
      }
      throw error;
    }
  }
  private async syncCurrent() {
    if (!this.initialized)
      await this.lease.run(async (lease) => {
        await this.engine.ensure();
        await this.store.initialize();
        await lease.assert();
        this.initialized = true;
      });
    if (!this.reconciled) {
      const state = await this.store.checkpoint(await this.engine.activeIndex());
      if (!state.complete && !state.position) await this.feed.reconcile();
      this.reconciled = true;
    }
    return this.lease.run(async (lease) => {
      const index = await this.engine.activeIndex(),
        checkpoint = await this.store.checkpoint(index);
      const page = await this.feed.read(checkpoint.position);
      await lease.assert();
      await this.store.apply(index, page.changes);
      await lease.assert();
      const complete = checkpoint.complete || page.next === page.through;
      if (!checkpoint.complete && complete) {
        await this.engine.request('/' + index + '/_refresh', 'POST');
        await lease.assert();
      }
      await this.store.save(index, page.next, complete, checkpoint.generation);
      await lease.assert();
      return page.next === page.through;
    });
  }
}
export class ProjectionWorker {
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = Promise.resolve();
  private failed = false;
  constructor(readonly projection: SearchProjection) {}
  onModuleInit() {
    this.start();
  }
  start() {
    if (this.stopped) {
      this.stopped = false;
      this.schedule(0);
    }
  }
  private schedule(delay: number) {
    if (!this.stopped)
      this.timer = setTimeout(() => {
        this.running = this.tick();
      }, delay);
  }
  private async tick() {
    let delay = 2000;
    try {
      if (!(await this.projection.sync())) delay = 100;
      if (this.failed) console.info(JSON.stringify({ kind: 'search_projection_recovered' }));
      this.failed = false;
    } catch {
      if (!this.failed) console.warn(JSON.stringify({ kind: 'search_projection_unavailable' }));
      this.failed = true;
    } finally {
      this.schedule(delay);
    }
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
  async onModuleDestroy() {
    await this.stop();
  }
}
