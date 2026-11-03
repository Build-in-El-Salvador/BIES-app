-- Invite-only sign-up (Admin Panel → Invites). The switch starts off: until
-- an admin turns it on, sign-up works as before.
ALTER TABLE "site_settings" ADD COLUMN "invite_only" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "site_settings" ADD COLUMN "invite_only_changed_at" DATETIME;
ALTER TABLE "site_settings" ADD COLUMN "invite_only_changed_by" TEXT;

-- One row per invite code. The code itself is never stored: code_hash is an
-- HMAC of it under a key the database doesn't hold, and code_sealed (the code
-- encrypted, for admins to share again) is wiped once it's used, revoked or
-- expired.
CREATE TABLE "invite_codes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code_hash" TEXT NOT NULL,
    "code_sealed" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "created_by_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "used_at" DATETIME,
    "used_by_id" TEXT,
    "revoked_at" DATETIME,
    CONSTRAINT "invite_codes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "invite_codes_used_by_id_fkey" FOREIGN KEY ("used_by_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "invite_codes_code_hash_key" ON "invite_codes"("code_hash");
CREATE UNIQUE INDEX "invite_codes_used_by_id_key" ON "invite_codes"("used_by_id");
CREATE INDEX "invite_codes_created_at_idx" ON "invite_codes"("created_at");
CREATE INDEX "invite_codes_expires_at_idx" ON "invite_codes"("expires_at");
