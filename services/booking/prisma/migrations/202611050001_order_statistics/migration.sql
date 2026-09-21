-- Publish complete current snapshots for orders created before statistics was introduced.
WITH snapshots AS (
  SELECT gen_random_uuid() AS "eventId", o.*,
    (SELECT count(*)::int FROM "OrderItem" i WHERE i."orderId" = o.id) AS "seatCount"
  FROM "Order" o
)
INSERT INTO "Outbox" (id, envelope)
SELECT "eventId", jsonb_build_object(
  'eventId', "eventId", 'eventType', 'OrderStatisticsChanged.v1', 'schemaVersion', 1,
  'aggregateId', id, 'aggregateVersion', CASE WHEN state = 'HELD' THEN 1 ELSE 2 END,
  'occurredAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'correlationId', gen_random_uuid(), 'producer', 'booking',
  'data', jsonb_build_object(
    'orderId', id, 'saleId', "saleId", 'organizationId', "organizationId", 'state', state,
    'seatCount', "seatCount", 'totalMinor', "totalMinor", 'currency', currency,
    'createdAt', to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', to_char("expiresAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'confirmedAt', to_char("confirmedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
) FROM snapshots;
