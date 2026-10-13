-- What a member wants push notifications about (Settings → Notifications).
-- Messages, follows and the two project switches already existed; these add
-- likes, comments and replies, profile views, zaps and event RSVPs. All on
-- by default, as before. The in-app list (the bell) is not affected.
--
-- Hand-written: SQLite's ADD COLUMN with a constant default, rather than
-- Prisma's rebuild of user_settings.

ALTER TABLE "user_settings" ADD COLUMN "notify_likes" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "user_settings" ADD COLUMN "notify_comments" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "user_settings" ADD COLUMN "notify_profile_views" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "user_settings" ADD COLUMN "notify_zaps" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "user_settings" ADD COLUMN "notify_events" BOOLEAN NOT NULL DEFAULT true;
