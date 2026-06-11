-- Run if you created the events table before anonymous-visitor tracking:
--   npx wrangler d1 execute bedtimetunes --remote --file db/alter_events_visitor.sql
ALTER TABLE events ADD COLUMN visitor TEXT;
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);