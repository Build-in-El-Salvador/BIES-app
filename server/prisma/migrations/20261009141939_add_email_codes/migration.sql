-- CreateTable
CREATE TABLE "email_codes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email_hash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'login',
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" DATETIME NOT NULL,
    "consumed_at" DATETIME,
    "ip_hash" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "email_codes_email_hash_purpose_created_at_idx" ON "email_codes"("email_hash", "purpose", "created_at");

-- CreateIndex
CREATE INDEX "email_codes_ip_hash_created_at_idx" ON "email_codes"("ip_hash", "created_at");

-- CreateIndex
CREATE INDEX "email_codes_created_at_idx" ON "email_codes"("created_at");

