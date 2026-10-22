-- Feedback becomes a tester's report: the page it's about, a screenshot
-- (a private file only admins open), and what the app sends with it.
ALTER TABLE "feedback" ADD COLUMN "page" TEXT NOT NULL DEFAULT '';
ALTER TABLE "feedback" ADD COLUMN "screenshot" TEXT NOT NULL DEFAULT '';
ALTER TABLE "feedback" ADD COLUMN "device" TEXT NOT NULL DEFAULT '{}';
