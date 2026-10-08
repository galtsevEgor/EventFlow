import { z } from 'zod';
import { validTraceparent } from '@eventflow/telemetry';

export const opsKind = z.enum(['payment', 'refund', 'webhook', 'mail']);
const cursorSchema = z.strictObject({
  at: z.iso.datetime(),
  kind: opsKind,
  id: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),
});
export const opsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  kind: opsKind.optional(),
  orderId: z.uuid().optional(),
  cursor: z
    .string()
    .max(600)
    .regex(/^[A-Za-z0-9_-]+$/)
    .transform((value, ctx) => {
      try {
        return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Недействительная страница' });
        return z.NEVER;
      }
    })
    .optional(),
});
export type OpsQuery = z.infer<typeof opsQuerySchema>;
export const opsIssueSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),
  kind: opsKind,
  state: z.string().regex(/^[A-Z_]{1,60}$/),
  code: z.string().max(60).nullable(),
  orderId: z.uuid().nullable(),
  recordedAt: z.iso.datetime(),
  traceId: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .nullable(),
});
export type OpsIssue = z.infer<typeof opsIssueSchema>;
export const opsActionSchema = z.strictObject({
  key: z.uuid(),
  actor: z.string().max(255),
  actorType: z.enum(['HUMAN', 'SERVICE']),
  reason: z.string().max(240).nullable(),
  createdAt: z.iso.datetime(),
  traceId: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .nullable(),
});
export const opsDetailSchema = z.strictObject({
  issue: opsIssueSchema,
  version: z.string().regex(/^[a-f0-9]{64}$/),
  recoverable: z.boolean(),
  facts: z.strictObject({
    amountMinor: z.number().int().nonnegative().optional(),
    currency: z.string().length(3).optional(),
    bookingState: z.string().max(60).optional(),
    attempts: z.number().int().nonnegative(),
    nextRunAt: z.iso.datetime().nullable(),
  }),
  actions: z.array(opsActionSchema).max(20),
});
export const opsOrderSchema = z.strictObject({
  id: z.uuid(),
  saleId: z.uuid(),
  state: z.string().max(30),
  totalMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  seatCount: z.number().int().nonnegative(),
});
export const opsPageSchema = z.strictObject({
  items: z.array(opsIssueSchema).max(50),
  nextCursor: z.string().max(600).nullable(),
});
export type RawOpsIssue = Omit<OpsIssue, 'recordedAt' | 'traceId'> & {
  at: Date;
  traceparent: string | null;
};
export function opsIssue(row: RawOpsIssue): OpsIssue {
  return opsIssueSchema.parse({
    id: row.id,
    kind: row.kind,
    state: row.state,
    code: row.code,
    orderId: row.orderId,
    recordedAt: row.at.toISOString(),
    traceId: validTraceparent(row.traceparent)?.split('-')[1] ?? null,
  });
}
export function opsPage(rows: RawOpsIssue[], limit: number) {
  const items = rows.slice(0, limit),
    last = items.at(-1);
  return {
    items: items.map(opsIssue),
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({ at: last.at.toISOString(), kind: last.kind, id: last.id }),
          ).toString('base64url')
        : null,
  };
}
