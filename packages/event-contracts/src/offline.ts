import { z } from 'zod';
import { admissionWindowSchema, checkInResult } from './check-in.js';

export const MAX_OFFLINE_SNAPSHOT_HASHES = 10_000;
export const MAX_OFFLINE_PAYLOAD_LENGTH = 1_000_000;
export const MAX_OFFLINE_SYNC_OPERATIONS = 50;

const id = z.uuid().transform((value) => value.toLowerCase());
export const offlinePrepareSchema = z.strictObject({
  deviceId: id,
  organizationId: id,
  eventId: id,
});
export const offlinePublicKeySchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  jwk: z.strictObject({
    kty: z.literal('OKP'),
    crv: z.literal('Ed25519'),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }),
});
export const offlineManifestSchema = admissionWindowSchema.extend({
  version: z.literal(1),
  sessionId: id,
  deviceId: id,
  actorSubject: z.string().min(1).max(255),
  organizationId: id,
  eventId: id,
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(MAX_OFFLINE_SNAPSHOT_HASHES),
});
export type OfflineManifest = z.infer<typeof offlineManifestSchema>;
export const offlineBundleSchema = z.strictObject({
  payload: z.string().min(1).max(MAX_OFFLINE_PAYLOAD_LENGTH),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  keyId: z.string().regex(/^[a-f0-9]{64}$/),
});
export type OfflineBundle = z.infer<typeof offlineBundleSchema>;
export const offlineScanSchema = z.strictObject({
  requestId: id,
  credential: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  capturedAt: z.iso.datetime(),
});
export const offlineSyncSchema = z.strictObject({
  sessionId: id,
  deviceId: id,
  operations: z
    .array(offlineScanSchema)
    .min(1)
    .max(MAX_OFFLINE_SYNC_OPERATIONS)
    .refine(
      (items) => new Set(items.map((item) => item.requestId)).size === items.length,
      'Повторяющиеся операции.',
    ),
});
export type OfflineSync = z.infer<typeof offlineSyncSchema>;
export const offlineReasonSchema = z.enum(['SNAPSHOT_EXPIRED', 'NOT_IN_SNAPSHOT']);
export const offlineResultSchema = z.strictObject({
  requestId: id,
  result: checkInResult,
  admittedAt: z.iso.datetime().nullable(),
  reason: offlineReasonSchema.nullable(),
});
export type OfflineResult = z.infer<typeof offlineResultSchema>;
export const offlineSyncResultSchema = z.strictObject({
  results: z.array(offlineResultSchema).max(MAX_OFFLINE_SYNC_OPERATIONS),
});
