-- Saved listings (a member's "Save" on a farm or business) and an optional
-- maps link per listing, for exact Directions.
--
-- Hand-written: Prisma would rebuild directory_listings to add one column;
-- SQLite's ADD COLUMN does the same with a constant default.

-- CreateTable
CREATE TABLE "saved_listings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "saved_listings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "saved_listings_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "directory_listings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "saved_listings_listing_id_idx" ON "saved_listings"("listing_id");

-- CreateIndex
CREATE UNIQUE INDEX "saved_listings_user_id_listing_id_key" ON "saved_listings"("user_id", "listing_id");

-- AlterTable
ALTER TABLE "directory_listings" ADD COLUMN "map_url" TEXT NOT NULL DEFAULT '';
