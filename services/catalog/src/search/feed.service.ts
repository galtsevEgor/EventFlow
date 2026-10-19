import { ApiError } from '@eventflow/service-runtime';
import { searchChangeSchema, type searchFeedQuerySchema } from '@eventflow/event-contracts';
import type { z } from 'zod';
import { Database } from '../database';
import { lockOrganization } from '../organizations/access';
import { captureSearchChange } from './snapshot';

export class SearchFeed {
  constructor(private readonly db: Database) {}
  async read(query: z.infer<typeof searchFeedQuerySchema>) {
    return this.db.$transaction(
      async (tx) => {
        const high = Number(
          (await tx.searchChange.aggregate({ _max: { position: true } }))._max.position ?? 0n,
        );
        if (!Number.isSafeInteger(high) || query.after > high || (query.through ?? high) > high)
          throw new ApiError(409, 'SEARCH_SOURCE_CHANGED', 'Перестройте поисковую проекцию.');
        const through = query.through ?? high;
        const rows = await tx.searchChange.findMany({
          where: { position: { gt: BigInt(query.after), lte: BigInt(through) } },
          orderBy: { position: 'asc' },
          take: query.limit,
        });
        return {
          changes: rows.map((row) =>
            searchChangeSchema.parse({
              position: Number(row.position),
              eventId: row.eventId,
              document: row.document,
            }),
          ),
          through,
          next: Number(rows.at(-1)?.position ?? BigInt(query.after)),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async reconcile(after: string | undefined, limit: number) {
    // Rebuild from current public state as well as the log, including older application writes.
    const rows = await this.db.$queryRaw<{ eventId: string }[]>`
      SELECT "eventId" FROM (
        SELECT "eventId" FROM "PublicEvent"
        UNION SELECT "eventId" FROM "SearchChange"
      ) candidates
      WHERE (${after ?? null}::uuid IS NULL OR "eventId" > ${after ?? null}::uuid)
      ORDER BY "eventId" LIMIT ${limit}
    `;
    for (const row of rows)
      await this.db.$transaction(async (tx) => {
        const draft = await tx.eventDraft.findUnique({
          where: { id: row.eventId },
          select: { organizationId: true },
        });
        if (draft) await lockOrganization(tx, draft.organizationId);
        await captureSearchChange(tx, row.eventId);
      });
    return { next: rows.length === limit ? rows.at(-1)!.eventId : null };
  }
}
