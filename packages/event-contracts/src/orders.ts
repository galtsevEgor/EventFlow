import { z } from 'zod';

// The durable queue retains these commands until the Payments consumer is connected.
export const orderClosedSchema = z.strictObject({ orderId: z.uuid(), saleId: z.uuid() });
export const orderRoutes = { payments: ['OrderExpired.v1', 'OrderCancelled.v1'] };
