-- A second ticket link for paying in bitcoin ("Pay with Bitcoin").
ALTER TABLE "events" ADD COLUMN "bitcoin_url" TEXT NOT NULL DEFAULT '';
