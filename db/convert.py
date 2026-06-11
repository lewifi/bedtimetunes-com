#!/usr/bin/env python3
"""
Bedtime Tunes — legacy MySQL dump -> Cloudflare D1 (SQLite) seed converter.

Handles:
  - broken CREATE TABLE (5 cols declared, 7 values per row)
  - inconsistent double/triple backslash escaping (\\' and \\\\\\' etc.)
  - literal \\r\\n newline escapes
  - HTML left in description fields
  - ID cap (default <= 146)
Outputs a clean seed.sql for `wrangler d1 execute`.
"""
import re, sys, html

SRC      = sys.argv[1] if len(sys.argv) > 1 else "tunes.sql"
OUT      = sys.argv[2] if len(sys.argv) > 2 else "seed.sql"
ID_CAP   = int(sys.argv[3]) if len(sys.argv) > 3 else 146

# Match: VALUES ( id , ts , 'a' , 'b' , 'c' , 'd' , uploader );
HEAD = re.compile(r"VALUES\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(.*)\s*,\s*(\d+)\s*\)\s*;?\s*$", re.S)
# field separator: a quote with NO preceding backslash, then , then quote
FIELD_SEP = re.compile(r"(?<!\\)'\s*,\s*'")

def clean(s: str) -> str:
    s = s.strip()
    if s.startswith("'"): s = s[1:]
    if s.endswith("'"):   s = s[:-1]
    # collapse any run of 2+ backslashes to a single one (un-double the escaping)
    s = re.sub(r"\\{2,}", r"\\", s)
    # standard unescape
    s = s.replace("\\r", "\r").replace("\\n", "\n").replace("\\t", "\t")
    s = s.replace("\\'", "'").replace('\\"', '"')
    s = s.replace("\\\\", "\\")
    # nuke any lone leftover backslash (no legit backslashes in this corpus)
    s = s.replace("\\", "")
    # CMS artifact that leaked into a couple of lyric fields
    s = s.replace("lyricstop", "")
    # normalize CRLF -> LF, trim trailing whitespace per line
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    s = "\n".join(line.rstrip() for line in s.split("\n")).strip()
    return s

def sqlq(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"

rows, uploaders, bad = [], set(), []
for raw in open(SRC, encoding="utf-8", errors="replace"):
    if "INSERT INTO" not in raw:
        continue
    m = HEAD.search(raw)
    if not m:
        bad.append(raw[:80]); continue
    tid, ts, middle, uploader = int(m.group(1)), int(m.group(2)), m.group(3), int(m.group(4))
    if tid > ID_CAP:
        continue
    parts = FIELD_SEP.split(middle)
    if len(parts) != 4:
        bad.append(f"id={tid} got {len(parts)} string fields"); continue
    title, artist, desc, lyrics = [clean(p) for p in parts]
    uploaders.add(uploader)
    rows.append((tid, ts, title, artist, desc, lyrics, uploader))

rows.sort(key=lambda r: r[0])

with open(OUT, "w", encoding="utf-8") as f:
    f.write("-- Bedtime Tunes D1 seed (auto-generated)\n")
    f.write("PRAGMA foreign_keys=OFF;\n\n")
    f.write("""DROP TABLE IF EXISTS tunes;
DROP TABLE IF EXISTS uploaders;

CREATE TABLE uploaders (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  avatar_url TEXT
);

CREATE TABLE tunes (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,          -- YYYYMMDDHHMMSS, primary sort key
  title       TEXT NOT NULL,
  artist      TEXT NOT NULL,
  description TEXT DEFAULT '',           -- curator notes (kept)
  uploader_id INTEGER DEFAULT 0,
  audio_key   TEXT,                      -- B2 object key; NULL = no MP3 synced yet
  duration_ms INTEGER,                   -- set by /api/sync later
  art_key     TEXT                       -- album art, later
);
CREATE INDEX idx_tunes_sort  ON tunes(ts DESC, id DESC);
CREATE INDEX idx_tunes_audio ON tunes(audio_key);

""")
    f.write("-- uploader stubs — edit names later\n")
    for u in sorted(uploaders):
        f.write(f"INSERT INTO uploaders (id, name) VALUES ({u}, 'uploader{u}');\n")
    f.write("\n")
    for (tid, ts, title, artist, desc, lyrics, uploader) in rows:
        f.write("INSERT INTO tunes (id, ts, title, artist, description, uploader_id) VALUES "
                f"({tid}, {ts}, {sqlq(title)}, {sqlq(artist)}, {sqlq(desc)}, {uploader});\n")

print(f"parsed {len(rows)} rows (cap id<={ID_CAP}); uploaders={sorted(uploaders)}; skipped/bad={len(bad)}")
for b in bad: print("  BAD:", b)
# spot-check the tricky unescape cases
for tid, ts, title, artist, desc, lyrics, up in rows:
    if tid in (1, 44, 50, 57):
        print(f"  id={tid}: title={title!r} artist={artist!r}")
