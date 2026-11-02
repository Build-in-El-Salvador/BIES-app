-- A member's profile on public Nostr (Settings → Nostr): off until they
-- switch it on, and which parts of their BIES profile it shows.
ALTER TABLE "profiles" ADD COLUMN "public_nostr" TEXT NOT NULL DEFAULT '{}';
