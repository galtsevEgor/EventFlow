import {
  orderStatisticsSchema,
  type EventEnvelope,
  type AnalyticsFact,
} from '@eventflow/event-contracts';
import { Journal } from './journal';

export class BookingAnalytics {
  constructor(private readonly journal: Journal) {}
  async handle(event: EventEnvelope) {
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
