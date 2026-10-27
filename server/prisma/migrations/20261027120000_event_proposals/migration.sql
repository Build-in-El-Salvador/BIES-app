-- Meetups members propose: one goes ahead once enough members are going by
-- its decide-by time, else it's called off. And the business or farm on BIES
-- where an event is (its venue). Columns are added in place (no table rebuilds).
ALTER TABLE "events" ADD COLUMN "min_attendees" INTEGER;
ALTER TABLE "events" ADD COLUMN "decide_by" DATETIME;
ALTER TABLE "events" ADD COLUMN "confirmed_at" DATETIME;
ALTER TABLE "events" ADD COLUMN "called_off_at" DATETIME;
ALTER TABLE "events" ADD COLUMN "venue_listing_id" TEXT REFERENCES "directory_listings" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "events_venue_listing_id_idx" ON "events"("venue_listing_id");
