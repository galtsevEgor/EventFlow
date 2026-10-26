import { z } from 'zod';
export const waitlistStateSchema = z.enum([
  'WAITING',
  'RESERVING',
  'OFFERED',
  'CANCELLING',
  'PURCHASED',
  'EXPIRED',
  'CANCELLED',
  'SKIPPED',
  'CLOSED',
]);
export const waitlistChangedSchema = z.strictObject({
  entryId: z.uuid(),
  saleId: z.uuid(),
  organizationId: z.uuid(),
  state: waitlistStateSchema,
  orderId: z.uuid().nullable(),
  occurredAt: z.iso.datetime(),
});
export const waitlistEntrySchema = z.strictObject({
  id: z.uuid(),
  saleId: z.uuid(),
  title: z.string(),
  categoryId: z.string(),
  state: waitlistStateSchema,
  orderId: z.uuid().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  serverNow: z.iso.datetime(),
  position: z.number().int().nonnegative().nullable(),
  createdAt: z.iso.datetime(),
});
export type WaitlistEntry = z.infer<typeof waitlistEntrySchema>;
export const waitlistInfoSchema = z.strictObject({
  enabled: z.boolean(),
  state: z.enum(['OPEN', 'PAUSED', 'SCHEDULED', 'CLOSED']),
  categories: z.array(z.strictObject({ id: z.string(), name: z.string() })),
});
