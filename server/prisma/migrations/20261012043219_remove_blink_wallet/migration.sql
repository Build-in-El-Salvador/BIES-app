-- The Blink wallet integration is gone (Blink's custodial accounts were
-- breached in Sept 2026). Production had no Blink connections when this was
-- written, so these columns held nothing.
/*
  Warnings:

  - You are about to drop the column `blink_api_key` on the `profiles` table. All the data in the column will be lost.
  - You are about to drop the column `blink_username` on the `profiles` table. All the data in the column will be lost.
  - You are about to drop the column `blink_wallet_id` on the `profiles` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_profiles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "bio" TEXT NOT NULL DEFAULT '',
    "avatar" TEXT NOT NULL DEFAULT '',
    "banner" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "skills" TEXT NOT NULL DEFAULT '[]',
    "website" TEXT NOT NULL DEFAULT '',
    "twitter" TEXT NOT NULL DEFAULT '',
    "linkedin" TEXT NOT NULL DEFAULT '',
    "github" TEXT NOT NULL DEFAULT '',
    "company" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL DEFAULT '',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "investment_focus" TEXT NOT NULL DEFAULT '[]',
    "investment_stage" TEXT NOT NULL DEFAULT '[]',
    "min_ticket" REAL,
    "max_ticket" REAL,
    "portfolio_count" INTEGER NOT NULL DEFAULT 0,
    "looking_for" TEXT NOT NULL DEFAULT '[]',
    "experience" TEXT NOT NULL DEFAULT '[]',
    "bies_projects" TEXT NOT NULL DEFAULT '[]',
    "custom_sections" TEXT NOT NULL DEFAULT '[]',
    "show_experience" BOOLEAN NOT NULL DEFAULT true,
    "nostr_feed_mode" TEXT NOT NULL DEFAULT 'combined',
    "nostr_npub" TEXT NOT NULL DEFAULT '',
    "nip05_name" TEXT,
    "lightning_address" TEXT NOT NULL DEFAULT '',
    "bolt12_offer" TEXT NOT NULL DEFAULT '',
    "coinos_username" TEXT,
    "coinos_token" TEXT,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_profiles" ("avatar", "banner", "bies_projects", "bio", "bolt12_offer", "coinos_token", "coinos_username", "company", "created_at", "custom_sections", "experience", "github", "id", "investment_focus", "investment_stage", "is_public", "lightning_address", "linkedin", "location", "looking_for", "max_ticket", "min_ticket", "name", "nip05_name", "nostr_feed_mode", "nostr_npub", "portfolio_count", "show_experience", "skills", "tags", "title", "twitter", "updated_at", "user_id", "view_count", "website") SELECT "avatar", "banner", "bies_projects", "bio", "bolt12_offer", "coinos_token", "coinos_username", "company", "created_at", "custom_sections", "experience", "github", "id", "investment_focus", "investment_stage", "is_public", "lightning_address", "linkedin", "location", "looking_for", "max_ticket", "min_ticket", "name", "nip05_name", "nostr_feed_mode", "nostr_npub", "portfolio_count", "show_experience", "skills", "tags", "title", "twitter", "updated_at", "user_id", "view_count", "website" FROM "profiles";
DROP TABLE "profiles";
ALTER TABLE "new_profiles" RENAME TO "profiles";
CREATE UNIQUE INDEX "profiles_user_id_key" ON "profiles"("user_id");
CREATE UNIQUE INDEX "profiles_nip05_name_key" ON "profiles"("nip05_name");
CREATE UNIQUE INDEX "profiles_coinos_username_key" ON "profiles"("coinos_username");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
