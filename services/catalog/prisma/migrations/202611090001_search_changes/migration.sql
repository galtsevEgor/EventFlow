CREATE TABLE "SearchChange" (
  "position" BIGSERIAL PRIMARY KEY,
  "eventId" UUID NOT NULL,
  "document" JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "SearchChange_eventId_position_idx" ON "SearchChange"("eventId", "position");

INSERT INTO "SearchChange" ("eventId", "document")
SELECT e.id, jsonb_build_object(
  'id', e.id, 'title', e.title, 'description', e.description,
  'city', p.city, 'address', p.address, 'timeZone', p."timeZone",
  'startsAt', to_char(p."startsAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'endsAt', to_char(p."endsAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'localDate', p."localDate", 'minPriceMinor', p."minPriceMinor",
  'currency', p.currency, 'capacity', p.capacity, 'coverId', e."coverId"
)
FROM "PublicEvent" p JOIN "EventDraft" e ON e.id = p."eventId"
JOIN "Publication" published ON published."eventId" = e.id AND published.state = 'PUBLISHED'
ORDER BY e.id;
