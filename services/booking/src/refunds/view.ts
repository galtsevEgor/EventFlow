import { z } from 'zod';
import { organizerRefundStates } from '@eventflow/event-contracts';
import type { OrderRefund } from '../generated/client';

export function refundView(refund: OrderRefund) {
  return {
    id: refund.id,
    orderId: refund.orderId,
    reason: refund.reason,
    state: z.enum(organizerRefundStates).parse(refund.state),
    code: refund.code,
    createdAt: refund.createdAt.toISOString(),
    updatedAt: refund.updatedAt.toISOString(),
    completedAt: refund.completedAt?.toISOString() ?? null,
  };
}
