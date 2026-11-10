import { z } from 'zod';
import { saleRoutes } from './sales.js';
import { orderRoutes } from './orders.js';
import { statisticsEventTypes } from './statistics.js';
import { refundRoutes } from './refunds.js';
import { realtimeEventTypes } from './realtime.js';
import { MAX_EVENT_TITLE_LENGTH } from './event-content.js';
import { eventCurrencySchema, MAX_ORDER_TOTAL_MINOR, MAX_SEATS_PER_ORDER } from './purchase.js';

export const paymentOrderSchema = z.strictObject({
  orderId: z.uuid(),
  buyerSubject: z.string().min(1).max(255),
  amountMinor: z.number().int().positive().max(MAX_ORDER_TOTAL_MINOR),
  currency: eventCurrencySchema,
  expiresAt: z.iso.datetime(),
  serverNow: z.iso.datetime(),
  state: z.enum(['HELD', 'CONFIRMED', 'EXPIRED', 'CANCELLED', 'REFUNDED']),
});
export const paymentSucceededSchema = z.strictObject({
  orderId: z.uuid(),
  attemptId: z.uuid(),
  providerPaymentId: z.string().min(1).max(255),
  buyerSubject: z.string().min(1).max(255),
  amountMinor: z.number().int().positive().max(MAX_ORDER_TOTAL_MINOR),
  currency: z.string().length(3),
  verifiedAt: z.iso.datetime(),
  provider: z.enum(['fake', 'stripe']),
});
export const refundRequestedSchema = paymentSucceededSchema.omit({ verifiedAt: true }).extend({
  operationId: z.uuid(),
  reason: z.enum(['HOLD_EXPIRED', 'ORDER_CANCELLED', 'SEATS_LOST', 'EXTRA_PAYMENT']),
});
export const paymentReviewSchema = z.strictObject({
  orderId: z.uuid(),
  attemptId: z.uuid(),
  providerPaymentId: z.string().min(1).max(255),
  code: z.string().min(1).max(60),
});
export const orderConfirmedSchema = z.strictObject({
  orderId: z.uuid(),
  attemptId: z.uuid(),
  providerPaymentId: z.string().min(1).max(255),
  saleId: z.uuid(),
  organizationId: z.uuid(),
  buyerSubject: z.string().min(1).max(255),
  title: z.string().min(1).max(MAX_EVENT_TITLE_LENGTH),
  totalMinor: z.number().int().positive(),
  currency: eventCurrencySchema,
  confirmedAt: z.iso.datetime(),
  items: z
    .array(
      z.strictObject({
        seatId: z.string().max(20),
        row: z.number().int().positive(),
        number: z.number().int().positive(),
        categoryName: z.string().max(60),
        priceMinor: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(MAX_SEATS_PER_ORDER),
});
export const commerceRoutes = {
  analytics: ['OrderStatisticsChanged.v1', 'WaitlistChanged.v1'],
  waitlist: ['OrderStatisticsChanged.v1', 'SaleAvailabilityChanged.v1'],
  search: ['SearchDocumentChanged.v1'],
  realtime: realtimeEventTypes,
  ...refundRoutes,
  catalog: saleRoutes.catalog,
  booking: [
    ...saleRoutes.booking,
    'PaymentSucceeded.v1',
    'RefundSucceeded.v1',
    'RefundFailed.v1',
    'RefundReviewRequired.v1',
  ],
  payments: [
    ...orderRoutes.payments,
    'OrderConfirmed.v1',
    'PaymentRefundRequested.v1',
    'PaymentReviewRequired.v1',
  ],
  tickets: ['OrderConfirmed.v1'],
  statistics: statisticsEventTypes,
};
export const refundOutcomeSchema = z.strictObject({
  operationId: z.uuid(),
  orderId: z.uuid(),
  attemptId: z.uuid(),
  providerPaymentId: z.string().min(1).max(255),
  providerRefundId: z.string().min(1).max(255).nullable(),
  state: z.enum(['SUCCEEDED', 'REQUIRES_REVIEW']),
  code: z.string().max(60).nullable(),
});
