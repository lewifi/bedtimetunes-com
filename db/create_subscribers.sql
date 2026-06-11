-- Mailing list for new-song updates + broadcasts.
-- Run once:  npx wrangler d1 execute bedtimetunes --remote --file db/create_subscribers.sql
CREATE TABLE IF NOT EXISTS subscribers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT UNIQUE NOT NULL,
  created_at   TEXT,
  token        TEXT,           -- unsubscribe token
  unsubscribed INTEGER DEFAULT 0,
  bounced      INTEGER DEFAULT 0
);