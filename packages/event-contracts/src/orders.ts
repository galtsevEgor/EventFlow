import { z } from 'zod';

// OrderExpired.v1 and OrderCancelled.v1 are persisted until Payments is connected.
export const orderClosedSchema = z.strictObject({ orderId: z.uuid(), saleId: z.uuid() });
