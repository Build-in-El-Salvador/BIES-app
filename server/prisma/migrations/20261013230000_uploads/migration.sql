-- The files members upload and who uploaded each (services/uploads.service.ts),
-- so a file can be deleted with what showed it, and an account's files with
-- the account.
--
-- Backfilled for the photos already on BIES that can be attributed: profile
-- photos and covers (their member) and listing photos (the listing's owner).
-- Others stay unrecorded, and so are never deleted automatically.

-- CreateTable
CREATE TABLE "uploads" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "user_id" TEXT,
    "mime_type" TEXT NOT NULL DEFAULT '',
    "size" INTEGER NOT NULL DEFAULT 0,
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "uploads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "uploads_name_key" ON "uploads"("name");

-- CreateIndex
CREATE INDEX "uploads_user_id_idx" ON "uploads"("user_id");

-- Backfill: the file name after /uploads/public/, when it has the shape
-- storage.service.ts gives names (milliseconds-hex.ext).
INSERT OR IGNORE INTO "uploads" ("id", "name", "user_id")
SELECT lower(hex(randomblob(12))), "name", "user_id" FROM (
    SELECT substr("avatar", instr("avatar", '/uploads/public/') + 16) AS "name", "user_id"
    FROM "profiles" WHERE instr("avatar", '/uploads/public/') > 0
    UNION ALL
    SELECT substr("banner", instr("banner", '/uploads/public/') + 16), "user_id"
    FROM "profiles" WHERE instr("banner", '/uploads/public/') > 0
    UNION ALL
    SELECT substr("photo", instr("photo", '/uploads/public/') + 16), "owner_id"
    FROM "directory_listings" WHERE instr("photo", '/uploads/public/') > 0
    UNION ALL
    SELECT substr("logo", instr("logo", '/uploads/public/') + 16), "owner_id"
    FROM "directory_listings" WHERE instr("logo", '/uploads/public/') > 0
    UNION ALL
    SELECT substr(p."value", instr(p."value", '/uploads/public/') + 16), l."owner_id"
    FROM "directory_listings" l,
         json_each(CASE WHEN json_valid(l."photos") THEN l."photos" ELSE '[]' END) p
    WHERE p."type" = 'text' AND instr(p."value", '/uploads/public/') > 0
)
WHERE "name" GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-*'
  AND "name" NOT GLOB '*[^0-9a-zA-Z.-]*';
