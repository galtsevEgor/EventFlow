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
    const { seats, ...sale } = parsed.data;
    const start = Date.parse(sale.startsAt),
      end = Date.parse(sale.endsAt),
      salesStart = Date.parse(sale.salesStartsAt),
      salesEnd = Date.parse(sale.salesEndsAt),
      admissionStart = Date.parse(sale.admissionStartsAt),
      admissionEnd = Date.parse(sale.admissionEndsAt);
    if (
      new Set(seats.map((s) => s.seatId)).size !== seats.length ||
      new Set(seats.map((s) => `${s.row}:${s.number}`)).size !== seats.length ||
      seats.some((s) => s.seatId !== `r${s.row}-s${s.number}`) ||
      !(
        salesStart < salesEnd &&
        salesEnd <= start &&
        start < end &&
        admissionStart < admissionEnd &&
        admissionStart <= start &&
        admissionEnd <= end
      )
    )
      throw new PermanentMessageError('Invalid sale invariants');
    try {
      new Intl.DateTimeFormat('en', { timeZone: sale.timeZone });
    } catch {
      throw new PermanentMessageError('Invalid timezone');
    }
    const snapshotHash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${event.aggregateId}, 0))`;
      if (await tx.inbox.findUnique({ where: { eventId: event.eventId } })) return;
      const existing = await tx.sale.findUnique({ where: { id: event.aggregateId } });
      if (
        existing &&
        (existing.snapshotHash !== snapshotHash || existing.version !== event.aggregateVersion)
      )
        throw new PermanentMessageError('Frozen sale conflict');
      if (!existing) {
        await tx.sale.create({
          data: { id: event.aggregateId, version: event.aggregateVersion, snapshotHash, ...sale },
        });
        await tx.seatInventory.createMany({
          data: seats.map((seat) => ({ saleId: event.aggregateId, ...seat })),
        });
      }
      const ack = message(
        'booking',
        'SaleProvisioned.v1',
        event.aggregateId,
        event.aggregateVersion,
        { snapshotHash },
        event,
      );
      await tx.outbox.create({ data: { id: ack.eventId, envelope: ack } });
      await tx.inbox.create({ data: { eventId: event.eventId } });
    });
  }
}
