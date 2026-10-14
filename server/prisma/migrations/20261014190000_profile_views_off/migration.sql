-- "X viewed your profile" is off unless a member turns it on (Settings → Notifications).
-- Existing rows got true from notification_categories on 14 Oct and no member had changed it, so they start off too.
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_user_settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "email_notifications" BOOLEAN NOT NULL DEFAULT true,
    "push_notifications" BOOLEAN NOT NULL DEFAULT true,
    "marketing_emails" BOOLEAN NOT NULL DEFAULT false,
    "notify_messages" BOOLEAN NOT NULL DEFAULT true,
    "notify_investments" BOOLEAN NOT NULL DEFAULT true,
    "notify_follows" BOOLEAN NOT NULL DEFAULT true,
    "notify_project_updates" BOOLEAN NOT NULL DEFAULT true,
    "notify_likes" BOOLEAN NOT NULL DEFAULT true,
    "notify_comments" BOOLEAN NOT NULL DEFAULT true,
    "notify_profile_views" BOOLEAN NOT NULL DEFAULT false,
    "notify_zaps" BOOLEAN NOT NULL DEFAULT true,
    "notify_events" BOOLEAN NOT NULL DEFAULT true,
    "browse_privately" BOOLEAN NOT NULL DEFAULT false,
    "relays" TEXT NOT NULL DEFAULT '[]',
    "media_read_items" TEXT NOT NULL DEFAULT '{}',
    "preferences" TEXT NOT NULL DEFAULT '{}',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_user_settings" ("browse_privately", "created_at", "email_notifications", "id", "marketing_emails", "media_read_items", "notify_comments", "notify_events", "notify_follows", "notify_investments", "notify_likes", "notify_messages", "notify_profile_views", "notify_project_updates", "notify_zaps", "preferences", "push_notifications", "relays", "updated_at", "user_id") SELECT "browse_privately", "created_at", "email_notifications", "id", "marketing_emails", "media_read_items", "notify_comments", "notify_events", "notify_follows", "notify_investments", "notify_likes", "notify_messages", false, "notify_project_updates", "notify_zaps", "preferences", "push_notifications", "relays", "updated_at", "user_id" FROM "user_settings";
DROP TABLE "user_settings";
ALTER TABLE "new_user_settings" RENAME TO "user_settings";
CREATE UNIQUE INDEX "user_settings_user_id_key" ON "user_settings"("user_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

