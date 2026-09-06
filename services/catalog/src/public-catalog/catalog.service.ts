import { z } from 'zod';
import { ApiError, parseInput } from '@eventflow/service-runtime';
import { Database } from '../database';
import type { Prisma } from '../generated/client';

const querySchema = z
  .strictObject({
    q: z.string().trim().max(160).default(''),
    city: z.string().trim().max(100).default(''),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(48).default(12),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'Начальная дата должна быть не позже конечной.',
    path: ['to'],
  });
const select = {
  eventId: true,
  city: true,
  address: true,
  timeZone: true,
  startsAt: true,
  endsAt: true,
  localDate: true,
  minPriceMinor: true,
  currency: true,
  capacity: true,
  event: { select: { title: true, description: true, coverId: true } },
} satisfies Prisma.PublicEventSelect;
type Entry = Prisma.PublicEventGetPayload<{ select: typeof select }>;
function view({ eventId, event, ...entry }: Entry) {
  return { id: eventId, ...entry, ...event };
}
function literal(value: string) {
  return value.replace(/[\\%_]/g, '\\$&');
}

export class PublicCatalog {
  constructor(private readonly db: Database) {}
  async list(input: unknown) {
    const query = parseInput(querySchema, input);
    return this.db.$transaction(
      async (tx) => {
        const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
        if (!clock) throw new Error('Database clock unavailable');
        const where: Prisma.PublicEventWhereInput = {
          endsAt: { gt: clock.now },
          ...(query.q
            ? { event: { title: { contains: literal(query.q), mode: 'insensitive' } } }
            : {}),
          ...(query.city ? { city: { equals: literal(query.city), mode: 'insensitive' } } : {}),
          ...(query.from || query.to
            ? {
                localDate: {
                  ...(query.from ? { gte: query.from } : {}),
                  ...(query.to ? { lte: query.to } : {}),
                },
              }
            : {}),
        };
        const total = await tx.publicEvent.count({ where });
        const rows = await tx.publicEvent.findMany({
          where,
          select,
          orderBy: [{ startsAt: 'asc' }, { eventId: 'asc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        });
        return {
          events: rows.map(view),
          total,
          page: query.page,
          pageSize: query.pageSize,
          pages: Math.ceil(total / query.pageSize),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async get(id: string) {
    const event = await this.db.publicEvent.findUnique({ where: { eventId: id }, select });
    if (!event) throw new ApiError(404, 'NOT_FOUND', 'Мероприятие не найдено.');
    return view(event);
  }
}
