import { z } from 'zod';

export const MAX_DOCUMENT_BYTES = 64 * 1024;
export const MAX_DESCRIPTION_LENGTH = 5000;
export const encodedState = z
  .string()
  .max(Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .min(4);
export const draftUpdateSchema = z.strictObject({ epoch: z.uuid(), state: encodedState });
export const draftSnapshotSchema = z.strictObject({
  epoch: z.uuid(),
  state: encodedState,
  version: z.number().int().positive(),
  canEdit: z.boolean(),
  description: z.string().max(MAX_DESCRIPTION_LENGTH),
});
export type DraftSnapshot = z.infer<typeof draftSnapshotSchema>;

export const clientFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('join'), clientId: z.number().int().min(0).max(0xffffffff) }),
  draftUpdateSchema.extend({ type: z.literal('update'), id: z.uuid() }),
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;
export const serverFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('snapshot'), snapshot: draftSnapshotSchema, peerId: z.uuid() }),
  z.strictObject({ type: z.literal('ack'), id: z.uuid(), snapshot: draftSnapshotSchema }),
  z.strictObject({
    type: z.literal('error'),
    code: z.string().max(64),
    message: z.string().max(240),
  }),
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;
