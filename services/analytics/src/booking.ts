import {
  orderStatisticsSchema,
  type EventEnvelope,
  type AnalyticsFact,
  waitlistChangedSchema,
} from '@eventflow/event-contracts';
import { Journal } from './journal';

export class BookingAnalytics {
  constructor(private readonly journal: Journal) {}
  async handle(event: EventEnvelope) {
    if (event.eventType === 'WaitlistChanged.v1') {
      if (event.producer !== 'waitlist') throw new Error('Invalid waitlist analytics producer');
      const d = waitlistChangedSchema.parse(event.data);
      if (d.entryId !== event.aggregateId) throw new Error('Invalid waitlist analytics aggregate');
      const kinds: Partial<Record<typeof d.state, AnalyticsFact['kind']>> = {
        WAITING: 'waitlist_joined',
        OFFERED: 'waitlist_offered',
        PURCHASED: 'waitlist_purchased',
        EXPIRED: 'waitlist_expired',
        CANCELLED: 'waitlist_cancelled',
        CLOSED: 'waitlist_closed',
        SKIPPED: 'waitlist_skipped',
      };
      const kind = kinds[d.state];
      if (!kind) return;
      await this.journal.append([
        {
          key: 'waitlist:' + d.entryId + ':' + d.state,
          kind,
          organizationId: d.organizationId,
          eventId: d.saleId,
          sessionId: null,
          orderId: d.orderId,
          searchId: null,
          waitlistEntryId: d.entryId,
          occurredAt: d.occurredAt,
          source: 'waitlist',
          resultCount: 0,
          limited: false,
        },
      ]);
      return;
    }
    if (event.eventType !== 'OrderStatisticsChanged.v1' || event.producer !== 'booking') return;
    const data = orderStatisticsSchema.parse(event.data);
    const base = {
      organizationId: data.organizationId,
      eventId: data.saleId,
      sessionId: data.analyticsSessionId ?? null,
      orderId: data.orderId,
      searchId: null,
      source: 'booking' as const,
      resultCount: 0,
      limited: false,
    };
    const facts: AnalyticsFact[] = [
      { ...base, key: 'order:' + data.orderId + ':held', kind: 'held', occurredAt: data.createdAt },
    ];
    if (data.state === 'CONFIRMED' && data.confirmedAt)
      facts.push({
        ...base,
        key: 'order:' + data.orderId + ':confirmed',
        kind: 'confirmed',
        occurredAt: data.confirmedAt,
      });
    await this.journal.append(facts);
  }
}
