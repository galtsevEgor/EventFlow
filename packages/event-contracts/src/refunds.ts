import { z } from 'zod';
import { eventCurrencySchema, MAX_ORDER_TOTAL_MINOR, MAX_SEATS_PER_ORDER } from './purchase.js';

const id = z.uuid();
export const ticketRefundLockSchema = z.strictObject({
  operationId: id,
  orderId: id,
  saleId: id,
  organizationId: id,
  seatIds: z
    .array(z.string().regex(/^r\d{1,2}-s\d{1,2}$/))
    .min(1)
    .max(MAX_SEATS_PER_ORDER)
    .refine((ids) => new Set(ids).size === ids.length),
  deadline: z.iso.datetime(),
});
export const ticketRefundResultSchema = z.strictObject({
  operationId: id,
  orderId: id,
  saleId: id,
  organizationId: id,
  code: z.enum(['TICKETS_USED', 'REFUND_WINDOW_CLOSED', 'TICKET_MISMATCH']).nullable(),
});
export const confirmedRefundCommandSchema = z.strictObject({
  operationId: id,
  orderId: id,
  attemptId: id,
  providerPaymentId: z.string().min(1).max(255),
  buyerSubject: z.string().min(1).max(255),
  amountMinor: z.number().int().positive().max(MAX_ORDER_TOTAL_MINOR),
  currency: eventCurrencySchema,
  provider: z.enum(['fake', 'stripe']),
  reason: z.literal('ORGANIZER_REQUESTED'),
});
export const orderRefundedSchema = z.strictObject({
  operationId: id,
  orderId: id,
  saleId: id,
  organizationId: id,
  attemptId: id,
  providerPaymentId: z.string().min(1).max(255),
  state: z.literal('REFUNDED'),
  seatCount: z.number().int().min(1).max(MAX_SEATS_PER_ORDER),
  totalMinor: z.number().int().positive().max(MAX_ORDER_TOTAL_MINOR),
  currency: eventCurrencySchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  confirmedAt: z.iso.datetime(),
  refundedAt: z.iso.datetime(),
});
export const organizerRefundInput = z.strictObject({ reason: z.string().trim().min(2).max(240) });
export const organizerRefundStates = [
  'FENCING',
  'PENDING',
  'REQUIRES_REVIEW',
  'REJECTED',
  'SUCCEEDED',
] as const;
export const refundRoutes = {
  'booking-refunds': [
    'TicketRefundLocked.v1',
    'TicketRefundLockRejected.v1',
    'ConfirmedOrderRefundSucceeded.v1',
    'ConfirmedOrderRefundReviewRequired.v1',
  ],
  'ticket-refunds': ['TicketRefundLockRequested.v1', 'OrderRefunded.v1'],
  'payment-refunds': ['ConfirmedOrderRefundRequested.v1'],
  'catalog-refunds': ['OrderRefunded.v1'],
};
