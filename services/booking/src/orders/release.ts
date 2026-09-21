import { message } from '@eventflow/event-contracts';
import type { Order } from '../generated/client';
import type { Transaction } from './transaction';
import { recordOrderStatistics } from './statistics';

// Caller holds this buyer's slot, order and all item seats, in that order.
export async function release(tx: Transaction, order: Order, state: 'EXPIRED' | 'CANCELLED') {
  if (order.state !== 'HELD') return;
  await tx.order.update({ where: { id: order.id }, data: { state } });
  await tx.seatInventory.updateMany({
    where: { saleId: order.saleId, currentOrderId: order.id, state: 'HELD' },
    data: { state: 'AVAILABLE', currentOrderId: null, expiresAt: null, version: { increment: 1 } },
  });
  await tx.buyerSaleSlot.updateMany({
    where: { saleId: order.saleId, buyerSubject: order.buyerSubject, currentOrderId: order.id },
    data: { currentOrderId: null },
  });
  const event = message(
    'booking',
    state === 'EXPIRED' ? 'OrderExpired.v1' : 'OrderCancelled.v1',
    order.id,
    2,
    { orderId: order.id, saleId: order.saleId },
  );
  await tx.outbox.create({ data: { id: event.eventId, envelope: event } });
  await recordOrderStatistics(tx, order.id);
}
