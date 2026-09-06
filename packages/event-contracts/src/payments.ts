import { z } from 'zod';
import { saleRoutes } from './sales.js';
import { orderRoutes } from './orders.js';

export const paymentOrderSchema = z.strictObject({
  orderId: z.uuid(),
  buyerSubject: z.string().min(1).max(255),
  amountMinor: z.number().int().positive().max(600_000_000),
  currency: z.literal('EUR'),
  expiresAt: z.iso.datetime(),
  serverNow: z.iso.datetime(),
  state: z.enum(['HELD', 'CONFIRMED', 'EXPIRED', 'CANCELLED']),
});
export const paymentSucceededSchema = z.strictObject({
  orderId: z.uuid(),
  attemptId: z.uuid(),
  providerPaymentId: z.string().min(1).max(255),
  buyerSubject: z.string().min(1).max(255),
  amountMinor: z.number().int().positive().max(600_000_000),
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
  title: z.string().min(1).max(160),
  totalMinor: z.number().int().positive(),
  currency: z.literal('EUR'),
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
    .max(6),
});
export const commerceRoutes = {
  catalog: saleRoutes.catalog,
  booking: [...saleRoutes.booking, 'PaymentSucceeded.v1'],
  payments: [
    ...orderRoutes.payments,
    'OrderConfirmed.v1',
    'PaymentRefundRequested.v1',
    'PaymentReviewRequired.v1',
  ],
  tickets: ['OrderConfirmed.v1'],
};
