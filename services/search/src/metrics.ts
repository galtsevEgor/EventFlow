import { currentTelemetry, type Measurement, type SnapshotName } from '@eventflow/telemetry';
import { IndexStore } from './index-store';
import { CatalogFeed } from './catalog-feed';
const names: SnapshotName[] = [
  'eventflow_dependency_up',
  'eventflow_search_checkpoint',
  'eventflow_search_cursor_gap',
  'eventflow_search_sync_age_seconds',
  'eventflow_search_ready',
];
export class SearchMetrics {
  private remove: (() => void) | undefined;
  constructor(
    private readonly store: IndexStore,
    private readonly feed: CatalogFeed,
  ) {}
  onModuleInit() {
    this.remove = currentTelemetry()?.metrics?.supply(names, () => this.collect());
  }
  onModuleDestroy() {
    this.remove?.();
  }
  async collect(): Promise<Measurement[]> {
    let checkpoint;
    try {
      await this.store.engine.health();
      checkpoint = await this.store.checkpoint(await this.store.engine.activeIndex());
    } catch {
      return [
        { name: 'eventflow_dependency_up', value: 0, attributes: { component: 'opensearch' } },
        { name: 'eventflow_search_ready', value: 0 },
      ];
    }
    const points: Measurement[] = [
      { name: 'eventflow_dependency_up', value: 1, attributes: { component: 'opensearch' } },
      { name: 'eventflow_search_checkpoint', value: checkpoint.position },
      { name: 'eventflow_search_ready', value: checkpoint.complete ? 1 : 0 },
      {
        name: 'eventflow_search_sync_age_seconds',
        value: Math.max(0, (Date.now() - Date.parse(checkpoint.updatedAt)) / 1000),
      },
    ];
    try {
      const source = await this.feed.read(checkpoint.position);
      points.push(
        { name: 'eventflow_dependency_up', value: 1, attributes: { component: 'search-source' } },
        { name: 'eventflow_search_cursor_gap', value: source.through - checkpoint.position },
      );
    } catch {
      points.push({
        name: 'eventflow_dependency_up',
        value: 0,
        attributes: { component: 'search-source' },
      });
    }
    return points;
  }
}
