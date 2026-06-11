-- Adds a location field to curators.
--   npx wrangler d1 execute bedtimetunes --remote --file db/alter_uploaders_location.sql
ALTER TABLE uploaders ADD COLUMN location TEXT;