import { message, searchDocumentSchema, searchChangeSchema } from '@eventflow/event-contracts';
import { Prisma } from '../generated/client';

export async function captureSearchChange(tx: Prisma.TransactionClient, eventId: string) {
  // Allocate feed positions in commit order, including changes in different organizations.
  // Callers acquire their organization lock first; no HTTP or broker call occurs here.
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(17001700)`;
  const row = await tx.publicEvent.findUnique({
    where: { eventId },
    include: {
      event: {
        select: {
          title: true,
          description: true,
          coverId: true,
          publication: { select: { state: true } },
        },
      },
    },
  });
  const document =
    row?.event.publication?.state === 'PUBLISHED'
      ? searchDocumentSchema.parse({
          id: row.eventId,
          title: row.event.title,
          description: row.event.description,
          city: row.city,
          address: row.address,
          timeZone: row.timeZone,
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
          localDate: row.localDate,
          minPriceMinor: row.minPriceMinor,
          currency: row.currency,
          capacity: row.capacity,
          coverId: row.event.coverId,
        })
      : null;
  const previous = await tx.searchChange.findFirst({
    where: { eventId },
    orderBy: { position: 'desc' },
  });
  const oldDocument = previous?.document ? searchDocumentSchema.parse(previous.document) : null;
  if (JSON.stringify(document) === JSON.stringify(oldDocument)) return;
  const saved = await tx.searchChange.create({
    data: { eventId, document: document ?? Prisma.DbNull },
  });
  const change = searchChangeSchema.parse({ position: Number(saved.position), eventId, document });
  const envelope = message('catalog', 'SearchDocumentChanged.v1', eventId, change.position, change);
  await tx.outbox.create({ data: { id: envelope.eventId, envelope } });
  return change;
}
