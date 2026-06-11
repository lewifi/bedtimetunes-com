-- Link curators to their Cloudflare Access identity + give them an avatar.
-- Run once:  npx wrangler d1 execute bedtimetunes --remote --file db/alter_uploaders.sql
-- (If it errors "duplicate column", that one's already applied — ignore.)
ALTER TABLE uploaders ADD COLUMN email TEXT;
ALTER TABLE uploaders ADD COLUMN photo TEXT;