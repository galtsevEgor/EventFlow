import { z } from 'zod';
import {
  analyticsBatchSchema,
  analyticsFactSchema,
  type AnalyticsFact,
} from '@eventflow/event-contracts';
import { ApiError, type ClientCredentials, parseInput } from '@eventflow/service-runtime';
import { Journal } from './journal';
export const ingestSchema = z.strictObject({
  sessionId: z.uuid(),
  events: analyticsBatchSchema.shape.events,
  searchIds: z.record(z.uuid(), z.uuid()).default({}),
});
export class AnalyticsIngest {
  constructor(
    private readonly journal: Journal,
    private readonly catalogUrl: string,
    private readonly credentials: Pick<ClientCredentials, 'token'>,
  ) {}
  async browser(input: unknown) {
    const { sessionId, events, searchIds } = parseInput(ingestSchema, input);
    const response = await fetch(new URL('/internal/analytics/events', this.catalogUrl), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(2000),
      headers: {
        authorization: 'Bearer ' + (await this.credentials.token()),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ids: [...new Set(events.map((e) => e.eventId))] }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Catalog metadata unavailable');
    }
    const metadata = z
      .strictObject({ events: z.array(z.strictObject({ id: z.uuid(), organizationId: z.uuid() })) })
      .parse(await response.json());
    const facts: AnalyticsFact[] = [];
    for (const event of events) {
      const org = metadata.events.find((item) => item.id === event.eventId);
      if (!org) continue;
      const age = Date.now() - Date.parse(event.occurredAt);
      if (age < -60000 || age > 24 * 3600000)
        throw new ApiError(422, 'ANALYTICS_TIME', 'Истёк срок события.');
      facts.push(
        analyticsFactSchema.parse({
          key: 'browser:' + event.id,
          kind: event.kind,
          organizationId: org.organizationId,
          eventId: event.eventId,
          sessionId,
          orderId: null,
          searchId: searchIds[event.id] ?? null,
          occurredAt: event.occurredAt,
          source: event.source,
        }),
      );
    }
    await this.journal.append(facts);
    return { accepted: facts.length };
  }
  async search(input: unknown) {
    const fact = parseInput(analyticsFactSchema, input);
    if (
      fact.kind !== 'search' ||
      fact.organizationId ||
      fact.eventId ||
      fact.orderId ||
      fact.sessionId ||
      !fact.searchId ||
      fact.key !== 'search:' + fact.searchId
    )
      throw new ApiError(422, 'INVALID_SEARCH_FACT', 'Неверное поисковое событие.');
    await this.journal.append([fact]);
    return { accepted: 1 };
  }
}
