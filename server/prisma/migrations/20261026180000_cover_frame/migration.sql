-- How each cover photo is framed on its page: the part of the photo the
-- member chose, as "x,y,w,h" in percent of the photo. Empty: centred.
ALTER TABLE "profiles" ADD COLUMN "cover_frame" TEXT NOT NULL DEFAULT '';
ALTER TABLE "projects" ADD COLUMN "cover_frame" TEXT NOT NULL DEFAULT '';
ALTER TABLE "events" ADD COLUMN "cover_frame" TEXT NOT NULL DEFAULT '';
ALTER TABLE "directory_listings" ADD COLUMN "cover_frame" TEXT NOT NULL DEFAULT '';
ALTER TABLE "talent_listings" ADD COLUMN "cover_frame" TEXT NOT NULL DEFAULT '';
