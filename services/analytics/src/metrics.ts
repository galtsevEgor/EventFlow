import { currentTelemetry, type SnapshotName, type Measurement } from '@eventflow/telemetry';
import { AnalyticsProjection } from './projection';
const names: SnapshotName[] = [
  'eventflow_dependency_up',
  'eventflow_analytics_pending',
  'eventflow_analytics_ready',
  'eventflow_analytics_sync_age_seconds',
];
export class AnalyticsMetrics {
  private remove: (() => void) | undefined;
  constructor(private readonly projection: AnalyticsProjection) {}
  onModuleInit() {
    this.remove = currentTelemetry()?.metrics?.supply(names, () => this.collect());
  }
  onModuleDestroy() {
    this.remove?.();
  }
  async collect(): Promise<Measurement[]> {
    try {
      const status = await this.projection.status();
      return [
        { name: 'eventflow_dependency_up', value: 1, attributes: { component: 'clickhouse' } },
        { name: 'eventflow_analytics_ready', value: 1 },
        { name: 'eventflow_analytics_pending', value: status.pending },
        {
          name: 'eventflow_analytics_sync_age_seconds',
          value: Math.max(0, (Date.now() - Date.parse(status.updatedAt)) / 1000),
        },
      ];
    } catch {
      return [
        { name: 'eventflow_dependency_up', value: 0, attributes: { component: 'clickhouse' } },
        { name: 'eventflow_analytics_ready', value: 0 },
      ];
    }
  }
}
