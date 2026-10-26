import { ClickHouse } from './clickhouse';
import { AnalyticsProjection } from './projection';
import { analyticsPeriodSchema, type AnalyticsPeriod } from '@eventflow/event-contracts';
export class WaitlistReport {
  constructor(
    private readonly engine: ClickHouse,
    private readonly projection: AnalyticsProjection,
  ) {}
  async read(organizationId: string, input: AnalyticsPeriod) {
    const period = analyticsPeriodSchema.parse(input),
      status = await this.projection.status();
    const [row] = await this.engine.rows<Record<string, string>>(
      `SELECT
     count() AS joined,countIf(offeredAt>=joinedAt) AS offered,
     countIf(purchasedAt>=offeredAt AND offeredAt>=joinedAt) AS purchased,
     countIf(expiredEvents>0) AS expired,countIf(cancelledEvents>0) AS cancelled,countIf(closedEvents>0) AS closed,countIf(skippedEvents>0) AS skipped
     FROM (
       SELECT waitlistEntryId,minIf(occurredAt,kind='waitlist_joined') AS joinedAt,
         minIf(occurredAt,kind='waitlist_offered') AS offeredAt,
         minIf(occurredAt,kind='waitlist_purchased') AS purchasedAt,
         countIf(kind='waitlist_expired') AS expiredEvents,countIf(kind='waitlist_cancelled') AS cancelledEvents,
         countIf(kind='waitlist_closed') AS closedEvents,countIf(kind='waitlist_skipped') AS skippedEvents
       FROM ${this.engine.table()} FINAL
       WHERE organizationId={org:String} AND source='waitlist' AND waitlistEntryId!=''
         AND ({event:String}='' OR eventId={event:String})
       GROUP BY waitlistEntryId HAVING countIf(kind='waitlist_joined')>0
         AND joinedAt>=toDateTime({from:String},'UTC') AND joinedAt<toDateTime({to:String},'UTC')+INTERVAL 1 DAY
     )`,
      { org: organizationId, event: period.eventId ?? '', from: period.from, to: period.to },
    );
    const joined = Number(row?.joined ?? 0),
      offered = Number(row?.offered ?? 0),
      purchased = Number(row?.purchased ?? 0);
    return {
      joined,
      offered,
      purchased,
      expired: Number(row?.expired ?? 0),
      cancelled: Number(row?.cancelled ?? 0),
      closed: Number(row?.closed ?? 0),
      skipped: Number(row?.skipped ?? 0),
      conversion: joined ? purchased / joined : null,
      offerConversion: offered ? purchased / offered : null,
      period,
      status,
      generatedAt: new Date().toISOString(),
      timeZone: 'UTC' as const,
    };
  }
}
