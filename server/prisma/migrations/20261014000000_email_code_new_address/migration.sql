-- email_codes.new_address: a code for an address with no account yet. Those
-- share only part of the daily ceiling (services/emailCode.service.ts), so
-- requests for made-up addresses can't use it all up and stop members from
-- signing in. Hand-written: SQLite's ADD COLUMN with a constant default.

ALTER TABLE "email_codes" ADD COLUMN "new_address" BOOLEAN NOT NULL DEFAULT false;
