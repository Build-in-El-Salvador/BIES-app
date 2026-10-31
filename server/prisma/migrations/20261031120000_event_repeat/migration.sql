-- Events that repeat (every week, every other week, a weekday of every
-- month), until a last day or for good; startDate and endDate stay the
-- first date. A member's answer on one is for one date. Columns are added
-- in place (no table rebuilds).
ALTER TABLE "events" ADD COLUMN "repeat" TEXT NOT NULL DEFAULT '';
ALTER TABLE "events" ADD COLUMN "repeat_until" DATETIME;
ALTER TABLE "event_attendees" ADD COLUMN "occurrence_start" DATETIME;
