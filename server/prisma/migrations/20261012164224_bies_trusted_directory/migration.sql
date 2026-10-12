-- BIES Trusted: members vouch for (+1) or downvote (-1) a listing, and the
-- BIES Trust Score is the difference. 5 or more makes it BIES Trusted.
-- Endorsements made before this were all recommendations, so they become vouches.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_directory_endorsements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "listing_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "vote" INTEGER NOT NULL DEFAULT 1,
    "comment" TEXT NOT NULL DEFAULT '',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "directory_endorsements_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "directory_listings" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "directory_endorsements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_directory_endorsements" ("comment", "created_at", "id", "listing_id", "user_id") SELECT "comment", "created_at", "id", "listing_id", "user_id" FROM "directory_endorsements";
DROP TABLE "directory_endorsements";
ALTER TABLE "new_directory_endorsements" RENAME TO "directory_endorsements";
CREATE UNIQUE INDEX "directory_endorsements_listing_id_user_id_key" ON "directory_endorsements"("listing_id", "user_id");
CREATE TABLE "new_directory_listings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "hours" TEXT NOT NULL DEFAULT '',
    "about" TEXT NOT NULL DEFAULT '',
    "photo" TEXT NOT NULL DEFAULT '',
    "logo" TEXT NOT NULL DEFAULT '',
    "photos" TEXT NOT NULL DEFAULT '[]',
    "location" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "whatsapp" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "instagram" TEXT NOT NULL DEFAULT '',
    "languages" TEXT NOT NULL DEFAULT '[]',
    "btc_accepted" BOOLEAN NOT NULL DEFAULT false,
    "products" TEXT NOT NULL DEFAULT '[]',
    "practices" TEXT NOT NULL DEFAULT '[]',
    "skills" TEXT NOT NULL DEFAULT '[]',
    "best_for" TEXT NOT NULL DEFAULT '',
    "pricing" TEXT NOT NULL DEFAULT '',
    "comment" TEXT NOT NULL DEFAULT '',
    "is_own_business" BOOLEAN NOT NULL DEFAULT false,
    "base_score" INTEGER NOT NULL DEFAULT 40,
    "reputation_score" INTEGER NOT NULL DEFAULT 0,
    "vouch_count" INTEGER NOT NULL DEFAULT 0,
    "downvote_count" INTEGER NOT NULL DEFAULT 0,
    "is_certified" BOOLEAN NOT NULL DEFAULT false,
    "certified_at" DATETIME,
    "certification_event_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending-review',
    "is_published" BOOLEAN NOT NULL DEFAULT true,
    "is_featured" BOOLEAN NOT NULL DEFAULT false,
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "nostr_listing_event_id" TEXT,
    "owner_id" TEXT NOT NULL,
    "member_user_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "directory_listings_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "directory_listings_member_user_id_fkey" FOREIGN KEY ("member_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_directory_listings" ("about", "base_score", "best_for", "btc_accepted", "certification_event_id", "certified_at", "comment", "created_at", "email", "id", "instagram", "is_certified", "is_featured", "is_published", "languages", "location", "logo", "member_user_id", "name", "nostr_listing_event_id", "owner_id", "phone", "photo", "photos", "practices", "pricing", "products", "reputation_score", "skills", "status", "type", "updated_at", "view_count", "website", "whatsapp") SELECT "about", "base_score", "best_for", "btc_accepted", "certification_event_id", "certified_at", "comment", "created_at", "email", "id", "instagram", "is_certified", "is_featured", "is_published", "languages", "location", "logo", "member_user_id", "name", "nostr_listing_event_id", "owner_id", "phone", "photo", "photos", "practices", "pricing", "products", "reputation_score", "skills", "status", "type", "updated_at", "view_count", "website", "whatsapp" FROM "directory_listings";
DROP TABLE "directory_listings";
ALTER TABLE "new_directory_listings" RENAME TO "directory_listings";
CREATE INDEX "directory_listings_type_status_idx" ON "directory_listings"("type", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Scores under the new rule: the old formula (admin base score, zaps,
-- completeness) no longer counts.
UPDATE "directory_listings" SET
    "vouch_count" = (SELECT COUNT(*) FROM "directory_endorsements" e WHERE e."listing_id" = "directory_listings"."id"),
    "downvote_count" = 0;
UPDATE "directory_listings" SET
    "reputation_score" = "vouch_count",
    "is_certified" = ("vouch_count" >= 5 AND "status" = 'active'),
    "certified_at" = CASE WHEN "vouch_count" >= 5 AND "status" = 'active' THEN COALESCE("certified_at", CURRENT_TIMESTAMP) ELSE NULL END;
