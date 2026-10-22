import {
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
    // Join chronological steps and the SAME order. Unattributed orders never manufacture a visit.
    const query = `WITH
    facts AS (SELECT * FROM ${this.engine.table()} FINAL WHERE organizationId={org:String}
      AND ({event:String}='' OR eventId={event:String})
      AND occurredAt>=toDateTime({from:String},'UTC')
      AND occurredAt<toDateTime({to:String},'UTC')+INTERVAL 2 DAY AND sessionId!=''),
    entries AS (SELECT eventId,sessionId,min(occurredAt) AS entered,argMin(source,occurredAt) AS entrySource
      FROM facts WHERE kind='impression' AND occurredAt<toDateTime({to:String},'UTC')+INTERVAL 1 DAY
      GROUP BY eventId,sessionId HAVING ({source:String}='' OR entrySource={source:String})),
    views AS (SELECT e.eventId,e.sessionId,e.entered,e.entrySource,min(f.occurredAt) AS viewed
      FROM entries e INNER JOIN facts f ON e.eventId=f.eventId AND e.sessionId=f.sessionId
      WHERE f.kind='event_view' AND f.occurredAt>=e.entered AND f.occurredAt<e.entered+INTERVAL 24 HOUR
      GROUP BY e.eventId,e.sessionId,e.entered,e.entrySource),
    holds AS (SELECT v.eventId,v.sessionId,f.orderId,v.entered,min(f.occurredAt) AS heldAt
      FROM views v INNER JOIN facts f ON v.eventId=f.eventId AND v.sessionId=f.sessionId
      WHERE f.kind='held' AND f.orderId!='' AND f.occurredAt>=v.viewed AND f.occurredAt<v.entered+INTERVAL 24 HOUR
      GROUP BY v.eventId,v.sessionId,f.orderId,v.entered),
    purchases AS (SELECT DISTINCT h.eventId,h.sessionId
      FROM holds h INNER JOIN facts f ON h.eventId=f.eventId AND h.sessionId=f.sessionId AND h.orderId=f.orderId
      WHERE f.kind='confirmed' AND f.occurredAt>=h.heldAt AND f.occurredAt<h.entered+INTERVAL 24 HOUR),
    heldSessions AS (SELECT DISTINCT eventId,sessionId FROM holds),
    clicks AS (SELECT DISTINCT e.eventId,e.sessionId FROM entries e INNER JOIN facts f ON e.eventId=f.eventId AND e.sessionId=f.sessionId
      WHERE f.kind='search_click' AND f.occurredAt>=e.entered AND f.occurredAt<e.entered+INTERVAL 24 HOUR)
    SELECT toString(toDate(e.entered,'UTC')) AS date,e.eventId AS eventId,e.entrySource AS source,count() AS impressions,
      countIf(v.sessionId!='') AS views,countIf(h.sessionId!='') AS held,countIf(p.sessionId!='') AS confirmed,
      countIf(c.sessionId!='' AND e.entrySource='search') AS clicks,countIf(e.entrySource='search') AS searchImpressions
    FROM entries e
    LEFT JOIN views v ON e.eventId=v.eventId AND e.sessionId=v.sessionId
    LEFT JOIN heldSessions h ON e.eventId=h.eventId AND e.sessionId=h.sessionId
    LEFT JOIN purchases p ON e.eventId=p.eventId AND e.sessionId=p.sessionId
    LEFT JOIN clicks c ON e.eventId=c.eventId AND e.sessionId=c.sessionId
    GROUP BY date,e.eventId,e.entrySource ORDER BY date,e.eventId,e.entrySource LIMIT 10000`;
    const groups = (await this.engine.rows<Group>(query, params)).map((row) => ({
      date: row.date,
      eventId: row.eventId,
      source: row.source,
      impressions: Number(row.impressions),
      views: Number(row.views),
      held: Number(row.held),
      confirmed: Number(row.confirmed),
      clicks: Number(row.clicks),
      searchImpressions: Number(row.searchImpressions),
    })) as (Omit<Group, (typeof numeric)[number]> & Record<(typeof numeric)[number], number>)[];
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
    const days = (Date.parse(query.to) - Date.parse(query.from)) / 86400000 + 1;
    const previous = {
      ...query,
      from: new Date(Date.parse(query.from) - days * 86400000).toISOString().slice(0, 10),
      to: new Date(Date.parse(query.from) - 86400000).toISOString().slice(0, 10),
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
      windowHours: 24,
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
