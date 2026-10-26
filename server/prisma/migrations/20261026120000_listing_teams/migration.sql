-- A business's team: members who represent it and host events as it.
-- CreateTable
CREATE TABLE "listing_team_members" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "listing_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "added_by_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "listing_team_members_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "directory_listings" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "listing_team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "listing_team_members_user_id_idx" ON "listing_team_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "listing_team_members_listing_id_user_id_key" ON "listing_team_members"("listing_id", "user_id");
