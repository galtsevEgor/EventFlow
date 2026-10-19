import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenSearch } from './opensearch';
import { IndexStore } from './index-store';
import { ProjectionBusy, ProjectionLease, type WriteLease } from './lease';
import { CatalogFeed } from './catalog-feed';

export class RebuildIndex {
  constructor(
    private readonly engine: OpenSearch,
    private readonly store: IndexStore,
    private readonly lease: ProjectionLease,
    private readonly feed: CatalogFeed,
  ) {}
  async run() {
    return this.lease.run(async (builder) => {
      await this.feed.reconcile();
      const initial = await this.feed.read(0);
      const index = this.engine.alias + '-v1-' + randomUUID();
      await this.engine.createIndex(index);
      try {
        const generation = await this.engine.identity(index);
        await this.copy(index, 0, initial.through, builder);
        for (let attempt = 0; ; attempt++) {
          await builder.assert();
          try {
            return await this.lease.run(async (writer) => {
              const previousIndex = await this.engine.activeIndex();
              const current = await this.feed.read(initial.through);
              await this.copy(index, initial.through, current.through, writer);
              await this.engine.request('/' + index + '/_refresh', 'POST');
              await builder.assert();
              await writer.assert();
              // Requiring the previous alias also rejects a stale concurrent cutover.
              await this.engine.request('/_aliases', 'POST', {
                actions: [
                  { remove: { index: previousIndex, alias: this.engine.alias, must_exist: true } },
                  { add: { index, alias: this.engine.alias } },
                ],
              });
              await writer.assert();
              // A crash before this write causes a conservative replay against the new generation.
              await this.store.save(index, current.through, true, generation);
              await writer.assert();
              return {
                index,
                previousIndex,
                position: current.through,
                completedAt: new Date().toISOString(),
              };
            });
          } catch (error) {
            if (!(error instanceof ProjectionBusy) || attempt >= 149) throw error;
            await delay(100);
          }
        }
      } catch (error) {
        // An unknown alias outcome must never delete an index which became active.
        try {
          if ((await this.engine.activeIndex()) !== index)
            await this.engine.request('/' + index, 'DELETE');
        } catch {
          /* Preserve the generation when its alias cannot be checked. */
        }
        throw error;
      }
    }, 'rebuild');
  }
  private async copy(index: string, after: number, through: number, lease: WriteLease) {
    let position = after;
    while (position < through) {
      await lease.assert();
      const page = await this.feed.read(position, through);
      await this.store.apply(index, page.changes);
      position = page.next;
    }
    await lease.assert();
  }
}
