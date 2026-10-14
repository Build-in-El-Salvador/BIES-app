-- uploads.shared: a file added to the shared GIF library, which other
-- members' posts can show too. Deleting a post or replacing a photo leaves
-- it; it goes with its uploader's account (services/uploads.service.ts).
-- Hand-written: SQLite's ADD COLUMN with a constant default.

ALTER TABLE "uploads" ADD COLUMN "shared" BOOLEAN NOT NULL DEFAULT false;
