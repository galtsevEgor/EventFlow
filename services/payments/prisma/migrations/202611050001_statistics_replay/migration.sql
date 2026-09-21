-- Dedicated routes keep replay pending until the new statistics queue exists.
-- Original financial events remain immutable and keep their original delivery state.
WITH replay AS (
  SELECT gen_random_uuid() AS id, envelope FROM "Outbox"
  WHERE envelope->>'eventType' IN ('PaymentSucceeded.v1', 'RefundSucceeded.v1')
)
INSERT INTO "Outbox" (id, envelope)
SELECT id, envelope || jsonb_build_object(
  'eventId', id, 'causationId', envelope->>'eventId',
  'eventType', CASE envelope->>'eventType'
    WHEN 'PaymentSucceeded.v1' THEN 'PaymentStatisticsReplayed.v1'
    ELSE 'RefundStatisticsReplayed.v1' END
) FROM replay;
