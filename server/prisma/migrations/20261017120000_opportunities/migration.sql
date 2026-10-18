-- Projects become opportunities: a type (investment, business for sale, job,
-- partnership, program) and the kind within it, where it is, how to reach
-- its member, its photos, and when it closes.
ALTER TABLE "projects" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'investment';
ALTER TABLE "projects" ADD COLUMN "kind" TEXT NOT NULL DEFAULT '';
ALTER TABLE "projects" ADD COLUMN "price" REAL;
ALTER TABLE "projects" ADD COLUMN "revenue" REAL;
ALTER TABLE "projects" ADD COLUMN "pay" TEXT NOT NULL DEFAULT '';
ALTER TABLE "projects" ADD COLUMN "location" TEXT NOT NULL DEFAULT '';
ALTER TABLE "projects" ADD COLUMN "remote" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "projects" ADD COLUMN "btc_accepted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "projects" ADD COLUMN "photos" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "projects" ADD COLUMN "whatsapp" TEXT NOT NULL DEFAULT '';
ALTER TABLE "projects" ADD COLUMN "email" TEXT NOT NULL DEFAULT '';
ALTER TABLE "projects" ADD COLUMN "closes_on" TEXT NOT NULL DEFAULT '';
ALTER TABLE "projects" ADD COLUMN "closed_at" DATETIME;

-- A project's cover becomes the first of its photos.
UPDATE "projects" SET "photos" = json_array("thumbnail") WHERE "thumbnail" <> '';

-- Industries folded into others.
UPDATE "projects" SET "category" = 'HEALTH' WHERE "category" = 'FITNESS';
UPDATE "projects" SET "category" = 'TECHNOLOGY' WHERE "category" IN ('SAAS', 'WEB3');
UPDATE "projects" SET "category" = 'RETAIL' WHERE "category" = 'ECOMMERCE';

-- CreateIndex
CREATE INDEX "projects_type_idx" ON "projects"("type");
