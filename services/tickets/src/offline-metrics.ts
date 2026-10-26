import { checkInResult } from '@eventflow/event-contracts';
import { currentTelemetry, type Measurement } from '@eventflow/telemetry';
import type { Database } from './database';

export class OfflineMetrics {
  private remove: (() => void) | undefined;
  constructor(private readonly db: Database) {}
  onModuleInit() {
    this.remove = currentTelemetry()?.metrics?.supply(
      ['eventflow_offline_sessions', 'eventflow_offline_scans'],
      () => this.collect(),
    );
  }
  onModuleDestroy() {
    this.remove?.();
  }
  async collect(): Promise<Measurement[]> {
    const [sessions, scans] = await Promise.all([
      this.db.$queryRaw<{ count: string }[]>`
        SELECT count(*)::text AS count FROM "OfflineSession" WHERE "expiresAt" > clock_timestamp()`,
      this.db.$queryRaw<{ result: string; count: string }[]>`
        SELECT result, count(*)::text AS count FROM "CheckIn"
        WHERE "offlineSessionId" IS NOT NULL GROUP BY result`,
    ]);
    return [
      {
        name: 'eventflow_offline_sessions',
        value: Number(sessions[0]?.count ?? 0),
        attributes: { state: 'ACTIVE' },
      },
      ...checkInResult.options.map((state) => ({
        name: 'eventflow_offline_scans' as const,
        value: Number(scans.find((scan) => scan.result === state)?.count ?? 0),
        attributes: { state },
      })),
    ];
  }
}
