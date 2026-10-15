-- BIES Talent: what members offer to do for others, with their proof of work.
-- CreateTable
CREATE TABLE "talent_listings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "about" TEXT NOT NULL DEFAULT '',
    "skills" TEXT NOT NULL DEFAULT '[]',
    "work_types" TEXT NOT NULL DEFAULT '[]',
    "available" BOOLEAN NOT NULL DEFAULT true,
    "remote" BOOLEAN NOT NULL DEFAULT false,
    "location" TEXT NOT NULL DEFAULT '',
    "rate" TEXT NOT NULL DEFAULT '',
    "btc_accepted" BOOLEAN NOT NULL DEFAULT false,
    "languages" TEXT NOT NULL DEFAULT '[]',
    "photo" TEXT NOT NULL DEFAULT '',
    "works" TEXT NOT NULL DEFAULT '[]',
    "whatsapp" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "talent_listings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "talent_listings_user_id_idx" ON "talent_listings"("user_id");

