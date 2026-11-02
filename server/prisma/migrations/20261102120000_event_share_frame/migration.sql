-- How a shared link's preview (WhatsApp and the like) frames the event's cover.
ALTER TABLE "events" ADD COLUMN "share_frame" TEXT NOT NULL DEFAULT '';
