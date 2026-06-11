-- Run if you already created the subscribers table before the bounce feature:
--   npx wrangler d1 execute bedtimetunes --remote --file db/alter_subscribers_bounced.sql
ALTER TABLE subscribers ADD COLUMN bounced INTEGER DEFAULT 0;