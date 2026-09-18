import { z } from 'zod';
import { ApiError, parseInput } from '@eventflow/service-runtime';
import { Database } from '../database';
import { Prisma } from '../generated/client';

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
type ListRow = { total: bigint } & (ReturnType<typeof view> | { id: null });
function literal(value: string) {
  return value.replace(/[\\%_]/g, '\\$&');
}

export class PublicCatalog {
  constructor(private readonly db: Database) {}
  async list(input: unknown) {
    const query = parseInput(querySchema, input);
    const { q, city, from, to, page, pageSize } = query;
    // Count and page share the same snapshot, including when the page is empty.
    const rows = await this.db.$queryRaw<ListRow[]>`
      WITH eligible AS NOT MATERIALIZED (
        SELECT p."eventId", p."startsAt"
        FROM "PublicEvent" p
        WHERE p."endsAt" > statement_timestamp()
          ${
            q
              ? Prisma.sql`AND EXISTS (
                SELECT 1 FROM "EventDraft" e
                WHERE e.id = p."eventId" AND e.title ILIKE ${'%' + literal(q) + '%'}
              )`
              : Prisma.empty
          }
          ${city ? Prisma.sql`AND p.city ILIKE ${literal(city)}` : Prisma.empty}
          ${from ? Prisma.sql`AND p."localDate" >= ${from}::char(10)` : Prisma.empty}
          ${to ? Prisma.sql`AND p."localDate" <= ${to}::char(10)` : Prisma.empty}
      ),
      page AS (
        SELECT "eventId", "startsAt" FROM eligible
        ORDER BY "startsAt", "eventId"
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
      )
      SELECT counts.total, p."eventId" AS id, p.city, p.address, p."timeZone",
        p."startsAt", p."endsAt", p."localDate", p."minPriceMinor", p.currency, p.capacity,
        e.title, e.description, e."coverId"
      FROM (SELECT count(*) AS total FROM eligible) counts
      LEFT JOIN page ON true
      LEFT JOIN "PublicEvent" p ON p."eventId" = page."eventId"
      LEFT JOIN "EventDraft" e ON e.id = p."eventId"
      ORDER BY page."startsAt", page."eventId"
    `;
    const events: ReturnType<typeof view>[] = [];
    let count = 0n;
    for (const { total, ...event } of rows) {
      count = total;
      if (event.id !== null) events.push(event);
    }
    const total = Number(count);
    return { events, total, page, pageSize, pages: Math.ceil(total / pageSize) };
  }
  async get(id: string) {
    const event = await this.db.publicEvent.findUnique({ where: { eventId: id }, select });
    if (!event) throw new ApiError(404, 'NOT_FOUND', 'Мероприятие не найдено.');
    return view(event);
  }
}
