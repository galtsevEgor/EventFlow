import { currentTelemetry, type Measurement } from '@eventflow/telemetry';
import { Database } from './database';
import { TemporalRuntime } from './runtime';
export class WaitlistMetrics {
  private remove: (() => void) | undefined;
  constructor(
    private readonly db: Database,
    private readonly runtime?: TemporalRuntime,
  ) {}
  onModuleInit() {
    this.remove = currentTelemetry()?.metrics?.supply(
      [
        'eventflow_waitlist_entries',
        'eventflow_waitlist_dispatch_pending',
        'eventflow_dependency_up',
      ],
      () => this.collect(),
    );
  }
  onModuleDestroy() {
    this.remove?.();
  }
  async collect(): Promise<Measurement[]> {
    const entries = await this.db.query<{ state: string; count: string }>(
      "SELECT state,count(*)::text AS count FROM waitlist_entry WHERE state IN ('WAITING','OFFERED','RESERVING','CANCELLING') GROUP BY state",
    );
    const [pending] = await this.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM workflow_dispatch WHERE revision>delivered',
    );
    let engine = 0;
    try {
      await this.runtime?.status();
      engine = this.runtime ? 1 : 0;
    } catch {
      /* Report dependency failure, not user identifiers. */
    }
    return [
      ...['WAITING', 'RESERVING', 'OFFERED', 'CANCELLING'].map((state) => ({
        name: 'eventflow_waitlist_entries' as const,
        value: Number(entries.find((e) => e.state === state)?.count ?? 0),
        attributes: { state },
      })),
      { name: 'eventflow_waitlist_dispatch_pending', value: Number(pending?.count ?? 0) },
      ...(this.runtime
        ? [
            {
              name: 'eventflow_dependency_up' as const,
              value: engine,
              attributes: { component: 'temporal' },
            },
          ]
        : []),
    ];
  }
}
