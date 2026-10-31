-- How the member who added a business or farm is connected to it: "STAFF"
-- when they work there (they go on its team and don't run it). Empty for
-- every listing before this: a recommendation, or the business's own page
-- run by the member who added it.
ALTER TABLE "directory_listings" ADD COLUMN "added_as" TEXT NOT NULL DEFAULT '';
