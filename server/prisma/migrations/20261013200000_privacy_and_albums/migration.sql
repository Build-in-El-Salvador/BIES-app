-- Settings → Privacy and photo albums.
--
-- profiles.privacy: who sees what, JSON { bio, location, links, details,
-- network }; missing keys take the defaults in services/profilePrivacy.ts.
-- user_settings.browse_privately: view profiles without "X viewed your
-- profile". albums / album_photos: a member's albums, or a farm's or
-- business's (exactly one of user_id and listing_id).
--
-- Hand-written: SQLite's ADD COLUMN with a constant default, rather than
-- Prisma's rebuild of profiles and user_settings.

ALTER TABLE "profiles" ADD COLUMN "privacy" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "user_settings" ADD COLUMN "browse_privately" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "albums" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT,
    "listing_id" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "visibility" TEXT NOT NULL DEFAULT 'MEMBERS',
    "cover_photo_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "albums_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "albums_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "directory_listings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "album_photos" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "album_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "caption" TEXT NOT NULL DEFAULT '',
    "width" INTEGER,
    "height" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "album_photos_album_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "albums_user_id_idx" ON "albums"("user_id");

-- CreateIndex
CREATE INDEX "albums_listing_id_idx" ON "albums"("listing_id");

-- CreateIndex
CREATE INDEX "album_photos_album_id_idx" ON "album_photos"("album_id");
