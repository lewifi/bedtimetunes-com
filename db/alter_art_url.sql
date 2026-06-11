-- Add album-art support without wiping existing data.
-- Run once:  npx wrangler d1 execute bedtimetunes --remote --file db/alter_art_url.sql
-- (SQLite has no "ADD COLUMN IF NOT EXISTS"; if it errors with "duplicate column", it's already applied — ignore.)
ALTER TABLE tunes ADD COLUMN art_url TEXT;