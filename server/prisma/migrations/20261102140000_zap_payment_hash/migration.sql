-- One receipt per Lightning payment: a zap receipt keeps its invoice's
-- payment hash, and no two receipts share one. Receipts stored before this
-- have none (NULL), which the unique index allows.
ALTER TABLE "zap_receipts" ADD COLUMN "payment_hash" TEXT;
CREATE UNIQUE INDEX "zap_receipts_payment_hash_key" ON "zap_receipts"("payment_hash");
