import { message, orderStatisticsSchema } from '@eventflow/event-contracts';
import type { Transaction } from './transaction';

export async function recordOrderStatistics(tx: Transaction, orderId: string) {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { _count: { select: { items: true } } },
  });
  const data = orderStatisticsSchema.parse({
    orderId: order.id,
    saleId: order.saleId,
    organizationId: order.organizationId,
    analyticsSessionId: order.analyticsSessionId,
    state: order.state,
    seatCount: order._count.items,
    totalMinor: order.totalMinor,
    currency: order.currency,
    createdAt: order.createdAt.toISOString(),
    expiresAt: order.expiresAt.toISOString(),
    confirmedAt: order.confirmedAt?.toISOString() ?? null,
  });
  // Orders have one terminal transition. A delayed HELD snapshot cannot replace it.
  const event = message(
    'booking',
    'OrderStatisticsChanged.v1',
    order.id,
    order.state === 'HELD' ? 1 : 2,
    { ...data, analyticsSessionId: order.analyticsSessionId },
  );
  await tx.outbox.create({ data: { id: event.eventId, envelope: event } });
}
