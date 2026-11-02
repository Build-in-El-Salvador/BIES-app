-- BIES addresses (Settings → Nostr): when a member claimed theirs, which is
-- what makes them verified, and the names given up or taken away, held for
-- a while so they can't pass at once to someone else.
ALTER TABLE "profiles" ADD COLUMN "nip05_claimed_at" DATETIME;

-- Names already chosen by their members stay verified. The ones sign-up
-- handed out ("nostr-" and 8 hex characters, maybe a number) stay unverified.
-- (Milliseconds, as Prisma stores dates in SQLite.)
UPDATE "profiles" SET "nip05_claimed_at" = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE "nip05_name" IS NOT NULL
  AND NOT (
    "nip05_name" GLOB 'nostr-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*'
    AND substr("nip05_name", 15) NOT GLOB '*[^0-9]*'
  );

CREATE TABLE "released_nip05" (
    "name" TEXT NOT NULL PRIMARY KEY,
    "pubkey" TEXT,
    "released_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blocked" BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX "released_nip05_pubkey_idx" ON "released_nip05"("pubkey");
