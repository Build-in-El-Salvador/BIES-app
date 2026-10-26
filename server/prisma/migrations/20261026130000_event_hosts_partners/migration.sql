-- Events hosted as a business or farm, with co-hosts and sponsors, and a
-- price line; a listing can be BIES's own page (its events are BIES events).
-- Columns are added in place (no table rebuilds).
ALTER TABLE "directory_listings" ADD COLUMN "is_official" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "events" ADD COLUMN "host_listing_id" TEXT REFERENCES "directory_listings" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "events" ADD COLUMN "price_label" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "events_host_listing_id_idx" ON "events"("host_listing_id");

-- CreateTable
CREATE TABLE "event_partners" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "event_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "user_id" TEXT,
    "listing_id" TEXT,
    "name" TEXT NOT NULL DEFAULT '',
    "logo" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "event_partners_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "event_partners_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "event_partners_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "directory_listings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "event_partners_event_id_idx" ON "event_partners"("event_id");
CREATE INDEX "event_partners_user_id_idx" ON "event_partners"("user_id");
CREATE INDEX "event_partners_listing_id_idx" ON "event_partners"("listing_id");
