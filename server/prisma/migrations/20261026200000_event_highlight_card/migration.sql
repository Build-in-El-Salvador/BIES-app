-- A BIES event's highlight card on Events: another photo for it (empty: the
-- cover) and how that photo shows in the card's shape ("x,y,w,h", as cover_frame).
ALTER TABLE "events" ADD COLUMN "card_image" TEXT NOT NULL DEFAULT '';
ALTER TABLE "events" ADD COLUMN "card_frame" TEXT NOT NULL DEFAULT '';
