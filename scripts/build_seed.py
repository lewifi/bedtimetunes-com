#!/usr/bin/env python3
"""
Build the Bedtime Tunes seed from three sources:
  1. your MP3 archive (songs/ folder)         -> owned tracks, full playback, ids 1..146
  2. the legacy phpMyAdmin dump (optional)     -> richer meta (real ts, description, uploader) for ids <=60
  3. the Spotify CSV export (Exportify)        -> the wider ~1200, spotify_id + duration + genre + added_at

Each Spotify track is fuzzy-matched to an MP3; matches reuse the MP3 id (so owned tracks
sort first, Tom Waits = id 1) and gain a spotify_id. Unmatched Spotify tracks get fresh ids
147.. ordered by added_at. MP3s not on Spotify stay as owned-only rows.

  python3 build_seed.py --csv export.csv --songs songs [--sql dump.sql] --out seed.sql

Source preference at play time: mp3_key > spotify_id (> youtube_id later).
"""
import os, re, csv, sys, argparse, unicodedata
from difflib import SequenceMatcher

ap = argparse.ArgumentParser()
ap.add_argument("--csv", required=True)
ap.add_argument("--songs", required=True)
ap.add_argument("--sql", default=None)
ap.add_argument("--out", default="seed.sql")
ap.add_argument("--cap", type=int, default=146)
ap.add_argument("--me", type=int, default=2)          # default uploader for unmapped contributors
ap.add_argument("--strong", type=float, default=0.84)
args = ap.parse_args()

ADDED_BY = {"lewihirvela": 2, "antisubliminal": 4}    # spotify handle -> uploader id

# ── normalization ──
SUFFIX = re.compile(r"\s*-\s*.*\b(remaster|remix|version|edit|mix|live|acoustic|mono|stereo|radio|demo|instrumental|feat).*$", re.I)
def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = SUFFIX.sub("", s)
    s = re.sub(r"\b(feat|ft|featuring|with)\b\.?", " ", s)
    s = s.replace("&", " and ")
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()

def sim(a, b): return SequenceMatcher(None, a, b).ratio()
def sqlq(s): return "'" + (s or "").replace("'", "''") + "'"

# ── 1. legacy SQL (optional): ts/desc/uploader for <=60, plus uploaders table ──
FIELD_SEP = re.compile(r"(?<!\\)'\s*,\s*'")
T_HEAD = re.compile(r"INSERT INTO `tunes` VALUES\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(.*)\s*,\s*(\d+)\s*\)\s*;?\s*$", re.S)
U_HEAD = re.compile(r"INSERT INTO `uploaders` VALUES\s*\(\s*(\d+)\s*,\s*(.*)\)\s*;?\s*$", re.S)
def clean(s):
    s = s.strip()
    if s.startswith("'"): s = s[1:]
    if s.endswith("'"): s = s[:-1]
    s = re.sub(r"\\{2,}", r"\\", s).replace("\\r", "\r").replace("\\n", "\n")
    s = s.replace("\\'", "'").replace('\\"', '"').replace("\\\\", "\\").replace("\\", "").replace("lyricstop", "")
    return s.replace("\r\n", "\n").replace("\r", "\n").strip()

sql_meta, uploaders = {}, []
if args.sql:
    for raw in open(args.sql, encoding="utf-8", errors="replace"):
        if raw.startswith("INSERT INTO `tunes`"):
            m = T_HEAD.search(raw)
            if not m: continue
            p = FIELD_SEP.split(m.group(3))
            if len(p) != 4: continue
            sql_meta[int(m.group(1))] = {"ts": int(m.group(2)), "desc": clean(p[2]), "uploader": int(m.group(4))}
        elif raw.startswith("INSERT INTO `uploaders`"):
            m = U_HEAD.search(raw)
            if not m: continue
            f = FIELD_SEP.split(m.group(2))
            if len(f) >= 6: uploaders.append((int(m.group(1)), clean(f[0]), clean(f[3]), clean(f[5])))

# ── 2. MP3 archive ──
FN = re.compile(r"^(\d{8})_(\d+)_(.+)$")
mp3 = {}   # id -> {date,title,artist,nt,na}
for fn in os.listdir(args.songs):
    if not fn.lower().endswith(".mp3"): continue
    m = FN.match(fn[:-4])
    if not m: print(f"  WARN bad filename: {fn}", file=sys.stderr); continue
    fid = int(m.group(2))
    if fid > args.cap: continue
    t, a = (m.group(3).split("_", 1) + [""])[:2]
    mp3.setdefault(fid, {"date": m.group(1), "title": t.strip(), "artist": a.strip(),
                         "nt": norm(t), "na": norm(a)})

# ── 3. Spotify CSV ──
spot = []
for r in csv.DictReader(open(args.csv, encoding="utf-8-sig")):
    sid = (r["Track URI"] or "").split(":")[-1]
    title = r["Track Name"].strip()
    artist = ", ".join(a.strip() for a in r["Artist Name(s)"].split(";") if a.strip())
    spot.append({"sid": sid, "title": title, "artist": artist,
                 "nt": norm(title), "na": norm(artist),
                 "dur": int(r["Duration (ms)"] or 0), "genre": r["Genres"].strip(),
                 "added": r["Added At"].strip(), "by": r["Added By"].strip(),
                 "pop": int(r["Popularity"] or 0)})

# ── match: each MP3 -> best Spotify track ──
link = {}   # mp3 id -> spot index
used = set()
for fid, mp in mp3.items():
    best, bi = 0.0, -1
    for i, s in enumerate(spot):
        if i in used: continue
        sc = sim(mp["nt"], s["nt"])
        if sc > best and (mp["na"] in s["na"] or s["na"] in mp["na"] or sim(mp["na"], s["na"]) >= 0.5):
            best, bi = sc, i
    if bi >= 0 and best >= args.strong:
        link[fid] = bi; used.add(bi)

# ── assemble rows ──
def ts_from(added):  # 2020-11-03T09:25:05Z -> 20201103092505
    return re.sub(r"[^0-9]", "", added)[:14].ljust(14, "0") if added else "00000000000000"

rows = []   # dict per track
# owned tracks (anchor on every MP3 we have)
for fid, mp in sorted(mp3.items()):
    s = spot[link[fid]] if fid in link else None
    meta = sql_meta.get(fid, {})
    rows.append({
        "id": fid,
        "ts": meta.get("ts") or (s and int(ts_from(s["added"]))) or int(mp["date"] + "000000"),
        "title": mp["title"], "artist": mp["artist"],
        "genre": (s or {}).get("genre", ""), "desc": meta.get("desc", ""), "hist": "",
        "uploader": meta.get("uploader") or ADDED_BY.get((s or {}).get("by"), args.me),
        "spotify": s["sid"] if s else None, "mp3": f"{fid}.mp3",
        "dur": (s["dur"] if s else None), "pop": (s["pop"] if s else None),
        "added": s["added"] if s else "",
    })
# spotify-only tracks (unmatched), new ids by added_at
rest = sorted((s for i, s in enumerate(spot) if i not in used), key=lambda s: s["added"])
nid = max(mp3) + 1 if mp3 else 147
nid = max(nid, args.cap + 1)
for s in rest:
    rows.append({
        "id": nid, "ts": int(ts_from(s["added"])), "title": s["title"], "artist": s["artist"],
        "genre": s["genre"], "desc": "", "hist": "",
        "uploader": ADDED_BY.get(s["by"], args.me),
        "spotify": s["sid"], "mp3": None, "dur": s["dur"], "pop": s["pop"], "added": s["added"],
    }); nid += 1

# ── emit ──
with open(args.out, "w", encoding="utf-8") as f:
    f.write("PRAGMA foreign_keys=OFF;\nDROP TABLE IF EXISTS tunes;\nDROP TABLE IF EXISTS uploaders;\n\n")
    f.write("""CREATE TABLE uploaders (id INTEGER PRIMARY KEY, name TEXT DEFAULT '', location TEXT, url TEXT);
CREATE TABLE tunes (
  id INTEGER PRIMARY KEY, ts INTEGER, title TEXT NOT NULL, artist TEXT NOT NULL,
  genre TEXT DEFAULT '', description TEXT DEFAULT '', historical TEXT DEFAULT '',
  uploader_id INTEGER DEFAULT 0,
  mp3_key TEXT, spotify_id TEXT, youtube_id TEXT, art_key TEXT,
  duration_ms INTEGER, popularity INTEGER, added_at TEXT
);
CREATE INDEX idx_tunes_id ON tunes(id);
CREATE INDEX idx_tunes_mp3 ON tunes(mp3_key);

""")
    if not uploaders:
        uploaders = [(args.me, "ephix", "", "")]
    for uid, n, loc, url in sorted(set(uploaders)):
        f.write(f"INSERT INTO uploaders (id,name,location,url) VALUES ({uid},{sqlq(n)},{sqlq(loc)},{sqlq(url)});\n")
    f.write("\n")
    for r in rows:
        f.write("INSERT INTO tunes (id,ts,title,artist,genre,description,historical,uploader_id,"
                "mp3_key,spotify_id,duration_ms,popularity,added_at) VALUES "
                f"({r['id']},{r['ts']},{sqlq(r['title'])},{sqlq(r['artist'])},{sqlq(r['genre'])},"
                f"{sqlq(r['desc'])},{sqlq(r['hist'])},{r['uploader']},"
                f"{sqlq(r['mp3']) if r['mp3'] else 'NULL'},{sqlq(r['spotify']) if r['spotify'] else 'NULL'},"
                f"{r['dur'] if r['dur'] else 'NULL'},{r['pop'] if r['pop'] is not None else 'NULL'},{sqlq(r['added'])});\n")

owned = len(mp3); matched = len(link)
print(f"owned MP3s={owned} (matched to spotify={matched}, owned-only={owned-matched})", file=sys.stderr)
print(f"spotify-only rows={len(rest)}  ->  total tunes={len(rows)}", file=sys.stderr)
print(f"ids: owned 1..{args.cap}, spotify-only {args.cap+1}..{nid-1}", file=sys.stderr)
