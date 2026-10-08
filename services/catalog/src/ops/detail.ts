import { ApiError, operationVersion } from '@eventflow/service-runtime';
import { opsIssue } from '@eventflow/event-contracts';
import { validTraceparent } from '@eventflow/telemetry';
import type { Database } from '../database';
export async function mailDetail(db: Database, id: string, canRecover: boolean) {
  const row = await db.deliveryJob.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Задача не найдена.');
  const actions = await db.deliveryRetry.findMany({
    where: { jobId: id },
    orderBy: [{ createdAt: 'desc' }, { requestId: 'desc' }],
    take: 20,
  });
  return {
    issue: opsIssue({
      id,
      kind: 'mail',
      state: row.state,
      code: null,
      orderId: null,
      at: row.nextRunAt,
      traceparent: row.traceparent,
    }),
    version: operationVersion(row.state, row.attempts, row.nextRunAt, row.lease, row.recoveryKey),
    recoverable: canRecover && row.state === 'DEAD',
    facts: { attempts: row.attempts, nextRunAt: row.nextRunAt.toISOString() },
    actions: actions.map((action) => ({
      key: action.requestId,
      actor: action.actorSubject,
      actorType: action.actorType === 'HUMAN' ? ('HUMAN' as const) : ('SERVICE' as const),
      reason: action.reason,
      createdAt: action.createdAt.toISOString(),
      traceId: validTraceparent(action.traceparent)?.split('-')[1] ?? null,
    })),
  };
}
