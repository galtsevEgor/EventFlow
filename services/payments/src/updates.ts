import { realtimeInvalidation } from '@eventflow/event-contracts';
import type { Prisma } from './generated/client';

export async function paymentUpdate(tx: Prisma.TransactionClient, orderId: string) {
  const event = realtimeInvalidation('payments', { scope: 'order', id: orderId });
  await tx.outbox.create({ data: { id: event.eventId, envelope: event } });
}
