-- One date of a repeating event that's different (another time, another
-- place) or called off, kept by the date's key: its start as the event's
-- rule makes it, as members' answers are. Null columns: as usual.
CREATE TABLE "event_date_changes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "event_id" TEXT NOT NULL,
    "occurrence_start" DATETIME NOT NULL,
    "start_date" DATETIME,
    "end_date" DATETIME,
    "title" TEXT,
    "description" TEXT,
    "location_name" TEXT,
    "location_address" TEXT,
    "location_map_url" TEXT,
    "is_online" BOOLEAN,
    "online_url" TEXT,
    "called_off_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "event_date_changes_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "event_date_changes_event_id_occurrence_start_key" ON "event_date_changes"("event_id", "occurrence_start");
