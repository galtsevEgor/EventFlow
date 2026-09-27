import { realtimeInvalidation } from '@eventflow/event-contracts';
import type { Transaction } from '../orders/transaction';
import type { Order } from '../generated/client';

export async function refundUpdate(
  tx: Transaction,
  order: Pick<Order, 'id' | 'saleId' | 'organizationId'>,
) {
  const events = [
    realtimeInvalidation('booking', { scope: 'order', id: order.id }),
    realtimeInvalidation('booking', {
      scope: 'organizer-orders',
      id: order.saleId,
      organizationId: order.organizationId,
    }),
  ];
  await tx.outbox.createMany({
    data: events.map((event) => ({ id: event.eventId, envelope: event })),
  });
}
