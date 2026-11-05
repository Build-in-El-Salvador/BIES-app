-- Edit profile: first and last name, more than one role, Instagram, a
-- member's own links, and sections switched off (services/profileFields.ts).
ALTER TABLE "profiles" ADD COLUMN "first_name" TEXT NOT NULL DEFAULT '';
ALTER TABLE "profiles" ADD COLUMN "last_name" TEXT NOT NULL DEFAULT '';
ALTER TABLE "profiles" ADD COLUMN "roles" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "profiles" ADD COLUMN "instagram" TEXT NOT NULL DEFAULT '';
ALTER TABLE "profiles" ADD COLUMN "custom_links" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "profiles" ADD COLUMN "hidden_sections" TEXT NOT NULL DEFAULT '[]';

-- Names as they are today: the first word, then the rest. Not the names
-- Nostr sign-in gives until a member chooses one ("nostr:1a2b3c4d").
UPDATE "profiles"
SET "first_name" = CASE WHEN instr(trim("name"), ' ') > 0 THEN substr(trim("name"), 1, instr(trim("name"), ' ') - 1) ELSE trim("name") END,
    "last_name"  = CASE WHEN instr(trim("name"), ' ') > 0 THEN trim(substr(trim("name"), instr(trim("name"), ' ') + 1)) ELSE '' END
WHERE trim("name") <> '' AND trim("name") NOT LIKE 'nostr:%';

-- Today's one role, as the first.
UPDATE "profiles"
SET "roles" = json_array(json_object('title', "title", 'company', "company"))
WHERE "title" <> '' OR "company" <> '';
