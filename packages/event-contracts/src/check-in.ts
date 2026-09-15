import { z } from 'zod';

export const admissionWindowSchema = z.strictObject({
  admissionStartsAt: z.iso.datetime(),
  admissionEndsAt: z.iso.datetime(),
});
export type AdmissionWindow = z.infer<typeof admissionWindowSchema>;

const id = z.uuid().transform((value) => value.toLowerCase());
export const checkInInput = z.strictObject({
  requestId: id,
  organizationId: id,
  eventId: id,
  credential: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
});
export type CheckInInput = z.infer<typeof checkInInput>;
export const checkInResult = z.enum([
  'ADMITTED',
  'ALREADY_USED',
  'WRONG_EVENT',
  'INVALID_TICKET',
  'WINDOW_CLOSED',
]);
export type CheckInResult = z.infer<typeof checkInResult>;
