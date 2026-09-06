CREATE TABLE "PublicEvent" (
 "eventId" UUID PRIMARY KEY REFERENCES "EventDraft"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "city" VARCHAR(100) NOT NULL, "address" VARCHAR(250) NOT NULL, "timeZone" VARCHAR(100) NOT NULL,
 "startsAt" TIMESTAMPTZ NOT NULL, "endsAt" TIMESTAMPTZ NOT NULL, "localDate" CHAR(10) NOT NULL,
 "minPriceMinor" INTEGER NOT NULL CHECK ("minPriceMinor" > 0), "currency" CHAR(3) NOT NULL CHECK ("currency" = 'EUR'),
 "capacity" INTEGER NOT NULL CHECK ("capacity" BETWEEN 1 AND 1000));
CREATE INDEX "PublicEvent_startsAt_eventId_idx" ON "PublicEvent"("startsAt", "eventId");
CREATE INDEX "PublicEvent_city_localDate_idx" ON "PublicEvent"("city", "localDate");
INSERT INTO "PublicEvent" ("eventId", "city", "address", "timeZone", "startsAt", "endsAt", "localDate", "minPriceMinor", "currency", "capacity")
SELECT d."id", d."configuration"->>'city', d."configuration"->>'address', p."snapshot"->>'timeZone',
 (p."snapshot"->>'startsAt')::timestamptz, (p."snapshot"->>'endsAt')::timestamptz,
 to_char((p."snapshot"->>'startsAt')::timestamptz AT TIME ZONE (p."snapshot"->>'timeZone'), 'YYYY-MM-DD'),
 (SELECT min((s->>'priceMinor')::integer) FROM jsonb_array_elements(p."snapshot"->'seats') s),
 p."snapshot"->>'currency', jsonb_array_length(p."snapshot"->'seats')
FROM "Publication" p JOIN "EventDraft" d ON d."id" = p."eventId" WHERE p."state" = 'PUBLISHED';
