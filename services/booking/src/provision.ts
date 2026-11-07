import { createHash } from 'node:crypto';
import { message, provisionSchema, type EventEnvelope } from '@eventflow/event-contracts';
import { PermanentMessageError } from '@eventflow/messaging';
import { Database } from './database';

export class ProvisionSale {
  constructor(private readonly db: Database) {}
  async handle(event: EventEnvelope) {
    const parsed = provisionSchema.safeParse(event.data);
    if (
      event.producer !== 'catalog' ||
      event.eventType !== 'SaleProvisionRequested.v1' ||
      event.aggregateVersion !== 1 ||
      !parsed.success
    )
      throw new PermanentMessageError('Invalid sale snapshot');
    const { seats, seatMap, ...sale } = parsed.data;
    const start = Date.parse(sale.startsAt),
      end = Date.parse(sale.endsAt),
      salesStart = Date.parse(sale.salesStartsAt),
      salesEnd = Date.parse(sale.salesEndsAt),
      admissionStart = Date.parse(sale.admissionStartsAt),
      admissionEnd = Date.parse(sale.admissionEndsAt);
    let valid = !(
      new Set(seats.map((s) => s.seatId)).size !== seats.length ||
      new Set(seats.map((s) => `${s.row}:${s.number}`)).size !== seats.length ||
      seats.some((s) => s.seatId !== `r${s.row}-s${s.number}`) ||
      !(
        salesStart < salesEnd &&
        salesEnd <= start &&
        start < end &&
        admissionStart < admissionEnd &&
        admissionStart <= start &&
        admissionEnd >= start &&
        admissionEnd <= end
      )
    );
    try {
      new Intl.DateTimeFormat('en', { timeZone: sale.timeZone });
    } catch {
      valid = false;
    }
    const snapshotHash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${event.aggregateId}, 0))`;
      if (await tx.inbox.findUnique({ where: { eventId: event.eventId } })) return;
      const existing = await tx.sale.findUnique({ where: { id: event.aggregateId } });
      const failure = !valid
        ? 'INVALID_SNAPSHOT'
        : existing &&
            (existing.snapshotHash !== snapshotHash || existing.version !== event.aggregateVersion)
          ? 'SNAPSHOT_CONFLICT'
          : null;
      if (!existing && !failure) {
        await tx.sale.create({
          data: {
            id: event.aggregateId,
            version: event.aggregateVersion,
            snapshotHash,
            ...sale,
            ...(seatMap ? { seatMap } : {}),
          },
        });
        await tx.seatInventory.createMany({
          data: seats.map((seat) => ({ saleId: event.aggregateId, ...seat })),
        });
      }
      const ack = message(
        'booking',
        failure ? 'SaleProvisionFailed.v1' : 'SaleProvisioned.v1',
        event.aggregateId,
        event.aggregateVersion,
        failure ? { snapshotHash, code: failure } : { snapshotHash },
        event,
      );
      await tx.outbox.create({ data: { id: ack.eventId, envelope: ack } });
      await tx.inbox.create({ data: { eventId: event.eventId } });
    });
  }
}
