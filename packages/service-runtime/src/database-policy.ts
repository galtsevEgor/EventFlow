export const prismaPostgresDefaults = {
  poolSize: { catalog: 12, booking: 12, payments: 10, tickets: 10 },
  pool: { connectionTimeoutMillis: 3_000, statement_timeout: 5_000 },
  transaction: { maxWait: 5_000, timeout: 10_000 },
} as const;

type PostgresPool = {
  options: { max?: number | undefined };
  totalCount: number;
  idleCount: number;
  waitingCount: number;
};

export function snapshotPostgresPool(pool: PostgresPool) {
  return {
    limit: pool.options.max,
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}
