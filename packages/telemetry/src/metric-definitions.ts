export const snapshotNames = [
  'eventflow_waitlist_entries',
  'eventflow_waitlist_dispatch_pending',
  'eventflow_analytics_pending',
  'eventflow_analytics_ready',
  'eventflow_analytics_sync_age_seconds',
  'eventflow_dependency_up',
  'eventflow_outbox_pending',
  'eventflow_outbox_oldest_seconds',
  'eventflow_mail_pending',
  'eventflow_mail_dead',
  'eventflow_payment_pending',
  'eventflow_payment_oldest_seconds',
  'eventflow_payment_review',
  'eventflow_refund_pending',
  'eventflow_refund_oldest_seconds',
  'eventflow_refund_review',
  'eventflow_db_pool_connections',
  'eventflow_db_pool_limit',
  'eventflow_tickets_used',
  'eventflow_sse_active',
  'eventflow_sse_opening',
  'eventflow_sse_ready',
  'eventflow_sse_events',
  'eventflow_search_checkpoint',
  'eventflow_search_cursor_gap',
  'eventflow_search_sync_age_seconds',
  'eventflow_search_ready',
  'eventflow_offline_sessions',
  'eventflow_offline_scans',
] as const;

export type SnapshotName = (typeof snapshotNames)[number];
export type Measurement = {
  name: SnapshotName;
  value: number;
  attributes?: { component?: string; state?: string; kind?: string; consumer?: string };
};

export function metricRoute(value: unknown) {
  if (typeof value !== 'string' || value.length > 128 || !/^\/[a-zA-Z0-9_/:[\]{}.*-]*$/.test(value))
    return 'unmatched';
  return value
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, ':id')
    .replace(/\/[0-9]+(?=\/|$)/g, '/:id');
}
export function metricMethod(value: string) {
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(value)
    ? value
    : 'OTHER';
}
