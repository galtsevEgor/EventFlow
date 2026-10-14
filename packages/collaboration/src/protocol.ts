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
