-- email_codes.quiet: a code that was answered as sent but not emailed, because
-- new addresses' share of the daily ceiling was used up. It counts against the
-- per-address and per-IP limits like any code (so the answers don't tell an
-- address with an account from one without), but not against the ceiling.
-- Hand-written: SQLite's ADD COLUMN with a constant default.

ALTER TABLE "email_codes" ADD COLUMN "quiet" BOOLEAN NOT NULL DEFAULT false;
