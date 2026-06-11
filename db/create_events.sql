-- Self-hosted analytics: site plays/shares + email clicks/opens.
-- Run once:  npx wrangler d1 execute bedtimetunes --remote --file db/create_events.sql
CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT,
  type     TEXT,      -- play, switch, share, page, subscribe, email_click, email_open
  track_id INTEGER,   -- nullable
  meta     TEXT,      -- nullable (source tag, campaign, etc.)
  country  TEXT       -- from request.cf.country
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_track ON events(track_id);