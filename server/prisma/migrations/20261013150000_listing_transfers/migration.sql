-- Handing a farm or business listing to the member who runs it: their
-- claim, or the owner's offer, and staff moves.

-- CreateTable
CREATE TABLE "listing_transfers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "listing_id" TEXT NOT NULL,
    "from_user_id" TEXT NOT NULL,
    "to_user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "owner_declined_at" DATETIME,
    "decided_by_id" TEXT,
    "decided_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "listing_transfers_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "directory_listings" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "listing_transfers_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "listing_transfers_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "listing_transfers_listing_id_status_idx" ON "listing_transfers"("listing_id", "status");

-- CreateIndex
CREATE INDEX "listing_transfers_status_idx" ON "listing_transfers"("status");
