import { currentTelemetry, type Measurement, type SnapshotName } from '@eventflow/telemetry';

type Query = <T>(sql: string) => Promise<T>;
type PoolSnapshot = () => {
  limit: number | undefined;
  total: number;
  idle: number;
  waiting: number;
};
type DatabaseRole = 'catalog' | 'booking' | 'payments' | 'tickets';

const outbox = `
  (SELECT count(*)::float8 FROM "Outbox" WHERE "sentAt" IS NULL) AS outbox_pending,
  (SELECT GREATEST(0, EXTRACT(EPOCH FROM (now() - min(COALESCE((envelope->>'occurredAt')::timestamptz, "availableAt"))))::float8) FROM "Outbox" WHERE "sentAt" IS NULL) AS outbox_oldest`;
const mail = `
  (SELECT count(*)::float8 FROM "DeliveryJob" WHERE state = 'PENDING') AS mail_pending,
  (SELECT count(*)::float8 FROM "DeliveryJob" WHERE state = 'DEAD') AS mail_dead`;
const sql: Record<DatabaseRole, string> = {
  catalog: `SELECT ${outbox}, ${mail}`,
  booking: `SELECT ${outbox}`,
  tickets: `SELECT ${outbox}, ${mail}, (SELECT count(*)::float8 FROM "Ticket" WHERE "usedAt" IS NOT NULL) AS tickets_used`,
  payments: `SELECT ${outbox},
    (SELECT count(*)::float8 FROM "PaymentAttempt" WHERE state NOT IN ('SUCCEEDED', 'CANCELLED', 'REQUIRES_REVIEW') OR (state = 'SUCCEEDED' AND "bookingState" = 'PENDING')) AS payment_pending,
    (SELECT GREATEST(0, EXTRACT(EPOCH FROM (now() - min("nextRunAt"))))::float8 FROM "PaymentAttempt" WHERE state NOT IN ('SUCCEEDED', 'CANCELLED', 'REQUIRES_REVIEW') OR (state = 'SUCCEEDED' AND "bookingState" = 'PENDING')) AS payment_oldest,
    (SELECT count(*)::float8 FROM "PaymentAttempt" WHERE state = 'REQUIRES_REVIEW' OR "bookingState" = 'REQUIRES_REVIEW') AS payment_review,
    (SELECT count(*)::float8 FROM "RefundOperation" WHERE state IN ('PENDING', 'UNKNOWN')) AS refund_pending,
    (SELECT GREATEST(0, EXTRACT(EPOCH FROM (now() - min("nextRunAt"))))::float8 FROM "RefundOperation" WHERE state IN ('PENDING', 'UNKNOWN')) AS refund_oldest,
    (SELECT count(*)::float8 FROM "RefundOperation" WHERE state = 'REQUIRES_REVIEW') AS refund_review`,
};
const names: Record<string, SnapshotName> = {
  outbox_pending: 'eventflow_outbox_pending',
  outbox_oldest: 'eventflow_outbox_oldest_seconds',
  mail_pending: 'eventflow_mail_pending',
  mail_dead: 'eventflow_mail_dead',
  payment_pending: 'eventflow_payment_pending',
  payment_oldest: 'eventflow_payment_oldest_seconds',
  payment_review: 'eventflow_payment_review',
  refund_pending: 'eventflow_refund_pending',
  refund_oldest: 'eventflow_refund_oldest_seconds',
  refund_review: 'eventflow_refund_review',
  tickets_used: 'eventflow_tickets_used',
};

export function observeDatabase(role: DatabaseRole, query: Query, pool: PoolSnapshot) {
  const metrics = currentTelemetry()?.metrics;
  if (!metrics) return () => {};
  return metrics.supply(
    [
      ...Object.values(names),
      'eventflow_dependency_up',
      'eventflow_db_pool_connections',
      'eventflow_db_pool_limit',
    ],
    async () => {
      try {
        const [row] = await query<Record<string, number>[]>(sql[role]);
        const values: Measurement[] = Object.entries(row ?? {}).flatMap(([key, value]) =>
          names[key] ? [{ name: names[key], value: Number(value) }] : [],
        );
        const snapshot = pool();
        values.push(
          { name: 'eventflow_dependency_up', value: 1, attributes: { component: 'database' } },
          { name: 'eventflow_db_pool_limit', value: snapshot.limit ?? 0 },
        );
        for (const state of ['total', 'idle', 'waiting'] as const)
          values.push({
            name: 'eventflow_db_pool_connections',
            value: snapshot[state],
            attributes: { state },
          });
        return values;
      } catch {
        return [
          { name: 'eventflow_dependency_up', value: 0, attributes: { component: 'database' } },
        ];
      }
    },
  );
}
