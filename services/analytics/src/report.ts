import {
  ANALYTICS_ATTRIBUTION_WINDOW_HOURS,
  ANALYTICS_UTC_DAY_MS,
  analyticsReportSchema,
  analyticsPeriodSchema,
  type AnalyticsPeriod,
} from '@eventflow/event-contracts';
import { ClickHouse } from './clickhouse';
import { AnalyticsProjection } from './projection';

type Group = {
  date: string;
  eventId: string;
  source: string;
  impressions: string;
  views: string;
  held: string;
  confirmed: string;
  clicks: string;
  searchImpressions: string;
};
const numeric = [
  'impressions',
  'views',
  'held',
  'confirmed',
  'clicks',
  'searchImpressions',
] as const;
const MAX_REPORT_GROUPS = 10_000;
export class AnalyticsReport {
  constructor(
    private readonly engine: ClickHouse,
    private readonly projection: AnalyticsProjection,
  ) {}
  private async period(organizationId: string, input: AnalyticsPeriod) {
    const params = {
      org: organizationId,
      from: input.from,
      to: input.to,
      event: input.eventId ?? '',
      source: input.source ?? '',
    };
    // Aggregate once per session/event; ordered arrays preserve the SAME-order conversion rule.
    const query = `WITH
    toDateTime({to:String},'UTC')+INTERVAL 1 DAY AS periodEnd,
    sessions AS (
      SELECT eventId,sessionId,
        minIf(occurredAt,kind='impression' AND occurredAt<periodEnd) AS entered,
        argMinIf(source,tuple(occurredAt,key),kind='impression' AND occurredAt<periodEnd) AS entrySource,
        countIf(kind='impression' AND occurredAt<periodEnd) AS entryCount,
        groupArrayIf(occurredAt,kind='event_view') AS viewTimes,
        groupArrayIf(tuple(occurredAt,orderId),kind='held') AS heldSteps,
        groupArrayIf(tuple(occurredAt,orderId),kind='confirmed') AS paidSteps,
        groupArrayIf(occurredAt,kind='search_click') AS clickTimes
      FROM ${this.engine.table()} FINAL
      WHERE organizationId={org:String} AND ({event:String}='' OR eventId={event:String})
        AND sessionId!='' AND occurredAt>=toDateTime({from:String},'UTC')
        AND occurredAt<periodEnd+INTERVAL ${ANALYTICS_ATTRIBUTION_WINDOW_HOURS} HOUR
      GROUP BY eventId,sessionId HAVING entryCount>0
    ),
    windows AS (SELECT *,entered+INTERVAL ${ANALYTICS_ATTRIBUTION_WINDOW_HOURS} HOUR AS attributionEnd
      FROM sessions WHERE {source:String}='' OR entrySource={source:String}),
    visits AS (SELECT *,arrayFilter(t->t>=entered AND t<attributionEnd,viewTimes) AS acceptedViews
      FROM windows),
    reservations AS (SELECT *,arrayFilter(h->notEmpty(acceptedViews) AND h.2!=''
      AND h.1>=arrayMin(acceptedViews) AND h.1<attributionEnd,heldSteps) AS acceptedHolds FROM visits)
    SELECT toString(toDate(entered,'UTC')) AS date,eventId,entrySource AS source,
      count() AS impressions,countIf(notEmpty(acceptedViews)) AS views,countIf(notEmpty(acceptedHolds)) AS held,
      countIf(arrayExists(c->c.1<attributionEnd AND arrayExists(h->h.2=c.2 AND c.1>=h.1,acceptedHolds),paidSteps)) AS confirmed,
      countIf(entrySource='search' AND arrayExists(t->t>=entered AND t<attributionEnd,clickTimes)) AS clicks,
      countIf(entrySource='search') AS searchImpressions
    FROM reservations GROUP BY date,eventId,entrySource ORDER BY date,eventId,entrySource LIMIT ${MAX_REPORT_GROUPS + 1}`;
    const rows = await this.engine.rows<Group>(query, params);
    if (rows.length > MAX_REPORT_GROUPS)
      throw new Error('Narrow the analytics period or event filter');
    const groups = rows.map((row) => ({
      date: row.date,
      eventId: row.eventId,
      source: row.source,
      impressions: Number(row.impressions),
      views: Number(row.views),
      held: Number(row.held),
      confirmed: Number(row.confirmed),
      clicks: Number(row.clicks),
      searchImpressions: Number(row.searchImpressions),
    }));
    const totals = Object.fromEntries(
      numeric.map((key) => [key, groups.reduce((sum, row) => sum + row[key], 0)]),
    ) as Record<(typeof numeric)[number], number>;
    return {
      ...totals,
      conversion: totals.impressions ? totals.confirmed / totals.impressions : null,
      ctr: totals.searchImpressions ? totals.clicks / totals.searchImpressions : null,
      groups,
    };
  }
  async read(organizationId: string, input: AnalyticsPeriod) {
    const query = analyticsPeriodSchema.parse(input);
    const status = await this.projection.status();
    const start = Date.parse(query.from);
    const duration = Date.parse(query.to) - start + ANALYTICS_UTC_DAY_MS;
    const previous = {
      ...query,
      from: new Date(start - duration).toISOString().slice(0, 10),
      to: new Date(start - ANALYTICS_UTC_DAY_MS).toISOString().slice(0, 10),
    };
    const [current, comparison] = await Promise.all([
      this.period(organizationId, query),
      this.period(organizationId, previous),
    ]);
    return analyticsReportSchema.parse({
      period: query,
      previousPeriod: previous,
      current,
      previous: comparison,
      status,
      generatedAt: new Date().toISOString(),
      timeZone: 'UTC',
      windowHours: ANALYTICS_ATTRIBUTION_WINDOW_HOURS,
    });
  }
  async search(input: AnalyticsPeriod) {
    const query = analyticsPeriodSchema.parse(input);
    const status = await this.projection.status();
    const [row] = await this.engine.rows<{ searches: string; empty: string; limited: string }>(
      `SELECT count() AS searches,countIf(resultCount=0) AS empty,countIf(limited=1) AS limited
      FROM ${this.engine.table()} FINAL WHERE kind='search' AND occurredAt>=toDateTime({from:String},'UTC')
      AND occurredAt<toDateTime({to:String},'UTC')+INTERVAL 1 DAY`,
      { from: query.from, to: query.to },
    );
    const searches = Number(row!.searches),
      empty = Number(row!.empty);
    return {
      searches,
      empty,
      limited: Number(row!.limited),
      emptyRate: searches ? empty / searches : null,
      status,
      period: query,
    };
  }
}
