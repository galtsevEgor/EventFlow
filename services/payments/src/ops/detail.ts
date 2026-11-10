import { opsIssue } from '@eventflow/event-contracts';
import { ApiError, operationVersion } from '@eventflow/service-runtime';
import { validTraceparent } from '@eventflow/telemetry';
import type { Database } from '../database';
import type { Prisma } from '../generated/client';
import { paymentVersion, refundVersion } from './versions';

const refundFields = {
  id: true,
  orderId: true,
  state: true,
  reviewCode: true,
  failures: true,
  nextRunAt: true,
  leaseUntil: true,
  recoveryKey: true,
  amountMinor: true,
  currency: true,
  createdAt: true,
  traceparent: true,
} as const;

const paymentFields = {
  ...refundFields,
  bookingState: true,
  cancelRequested: true,
  authorized: true,
} as const;

const webhookFields = {
  eventId: true,
  reviewCode: true,
  failures: true,
  processedAt: true,
  createdAt: true,
  nextRunAt: true,
  traceparent: true,
} as const;

const actionFields = {
  key: true,
  actor: true,
  reason: true,
  createdAt: true,
  actorType: true,
  traceparent: true,
} as const;
const RECENT_OPERATOR_ACTIONS_LIMIT = 20;

type OperationKind = 'payment' | 'refund';
type OperationRow =
  | Prisma.PaymentAttemptGetPayload<{ select: typeof paymentFields }>
  | Prisma.RefundOperationGetPayload<{ select: typeof refundFields }>;
type ActionRow = Prisma.OperatorActionGetPayload<{ select: typeof actionFields }>;

function readOperation(db: Database, kind: OperationKind, id: string) {
  return kind === 'payment'
    ? db.paymentAttempt.findUnique({ where: { id }, select: paymentFields })
    : db.refundOperation.findUnique({ where: { id }, select: refundFields });
}

function readRecentActions(db: Database, kind: OperationKind, id: string) {
  return db.operatorAction.findMany({
    where: { kind, targetId: id },
    orderBy: [{ createdAt: 'desc' }, { key: 'desc' }],
    take: RECENT_OPERATOR_ACTIONS_LIMIT,
    select: actionFields,
  });
}

async function readWebhookDetail(db: Database, id: string) {
  const row = await db.providerWebhook.findUnique({
    where: { eventId: id },
    select: webhookFields,
  });
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Запись не найдена.');
  return {
    issue: opsIssue({
      id: row.eventId,
      kind: 'webhook',
      state: row.reviewCode ? 'REQUIRES_REVIEW' : row.processedAt ? 'PROCESSED' : 'PENDING',
      code: row.reviewCode,
      orderId: null,
      at: row.createdAt,
      traceparent: row.traceparent,
    }),
    version: operationVersion(row.reviewCode, row.failures, row.processedAt),
    recoverable: false,
    facts: { attempts: row.failures, nextRunAt: row.nextRunAt.toISOString() },
    actions: [],
  };
}

function operationDetail(
  row: OperationRow,
  kind: OperationKind,
  id: string,
  recoverable: boolean,
  actions: ActionRow[],
) {
  const isPayment = 'bookingState' in row;
  return {
    issue: opsIssue({
      id,
      kind,
      state: row.state,
      code: row.reviewCode,
      orderId: row.orderId,
      at: row.createdAt,
      traceparent: row.traceparent,
    }),
    version: isPayment ? paymentVersion(row) : refundVersion(row),
    recoverable,
    facts: {
      amountMinor: row.amountMinor,
      currency: row.currency,
      ...(isPayment ? { bookingState: row.bookingState } : {}),
      attempts: row.failures,
      nextRunAt: row.nextRunAt.toISOString(),
    },
    actions: actions.map((action) => ({
      key: action.key,
      actor: action.actor,
      reason: action.reason,
      actorType: action.actorType === 'HUMAN' ? ('HUMAN' as const) : ('SERVICE' as const),
      createdAt: action.createdAt.toISOString(),
      traceId: validTraceparent(action.traceparent)?.split('-')[1] ?? null,
    })),
  };
}

export async function readPaymentIssueDetail(
  db: Database,
  kind: OperationKind | 'webhook',
  id: string,
  canRecover: boolean,
) {
  if (kind === 'webhook') return readWebhookDetail(db, id);
  const row = await readOperation(db, kind, id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Запись не найдена.');
  const recoverable =
    canRecover &&
    !(row.leaseUntil && row.leaseUntil > new Date()) &&
    ('bookingState' in row
      ? ['NEEDS_RECONCILIATION', 'REQUIRES_REVIEW'].includes(row.state) &&
        row.reviewCode !== 'BOOKING_BINDING_REVIEW'
      : ['UNKNOWN', 'REQUIRES_REVIEW'].includes(row.state));
  const actions = await readRecentActions(db, kind, id);
  return operationDetail(row, kind, id, recoverable, actions);
}
