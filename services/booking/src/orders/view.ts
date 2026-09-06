import type { Order, OrderItem } from '../generated/client';
import { effectiveState } from './transaction';

export function orderView(order: Order & { items: OrderItem[] }, now: Date) {
  return {
    id: order.id,
    saleId: order.saleId,
    title: order.title,
    currency: order.currency,
    totalMinor: order.totalMinor,
    state: effectiveState(order, now),
    createdAt: order.createdAt.toISOString(),
    expiresAt: order.expiresAt.toISOString(),
    serverNow: now.toISOString(),
    items: order.items.map(({ seatId, row, number, categoryName, priceMinor }) => ({
      seatId,
      row,
      number,
      categoryName,
      priceMinor,
    })),
  };
}
