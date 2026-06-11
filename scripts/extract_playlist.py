#!/usr/bin/env python3
"""
Extract a Spotify playlist's tracks into Bedtime Tunes formats.

Auth: client-credentials (public playlist, no user login).
  Set env vars from your Spotify developer dashboard:
    SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET

Usage:
  python3 extract_playlist.py [--format csv|filename|sql] [--start-id N] [--playlist ID]

Formats:
  csv       position, added_date, title, artist        (default; review-friendly)
  filename  YYYYMMDD_ID_Title_Artist.mp3               (matches your archive naming)
  sql       INSERT INTO tunes (...) ...                (D1 seed rows)

Notes:
  - Spotify gives `added_at` = when the track was added to the playlist, which it
    uses as ts (YYYYMMDDHHMMSS) and as the date. For pre-Spotify-era tracks this is
    NOT the original 2006/2007 date — your legacy seed.sql has the truer timestamps.
  - Spotify has no notion of your legacy integer IDs, so filename/sql modes assign
    fresh sequential IDs starting at --start-id (default 200, safely past your cap).
  - Featured artists come back as separate entries -> joined with ", ".
"""
import os, sys, csv, json, base64, urllib.request, urllib.parse, argparse

CID = os.environ.get("SPOTIFY_CLIENT_ID")
SEC = os.environ.get("SPOTIFY_CLIENT_SECRET")

ap = argparse.ArgumentParser()
ap.add_argument("--format", choices=["csv", "filename", "sql"], default="csv")
ap.add_argument("--start-id", type=int, default=200)
ap.add_argument("--playlist", default="6AGKG8W0y4xezu8Cl6Rtkj")
ap.add_argument("--out", default=None)
args = ap.parse_args()

if not CID or not SEC:
    sys.exit("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET env vars.")

def http(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())

# 1) token
tok = http(
    "https://accounts.spotify.com/api/token",
    data=urllib.parse.urlencode({"grant_type": "client_credentials"}).encode(),
    headers={
        "Authorization": "Basic " + base64.b64encode(f"{CID}:{SEC}".encode()).decode(),
        "Content-Type": "application/x-www-form-urlencoded",
    },
)["access_token"]
H = {"Authorization": "Bearer " + tok}

# 2) paginate playlist
rows, url = [], (
    f"https://api.spotify.com/v1/playlists/{args.playlist}/tracks"
    "?fields=items(added_at,track(name,artists(name))),next&limit=100"
)
while url:
    page = http(url, headers=H)
    for it in page.get("items", []):
        t = it.get("track")
        if not t or not t.get("name"):
            continue
        title = t["name"]
        artist = ", ".join(a["name"] for a in t.get("artists", []) if a.get("name"))
        added = (it.get("added_at") or "")  # 2014-09-01T12:34:56Z
        ymd = added[:10].replace("-", "")            # 20140901
        ts = ymd + added[11:19].replace(":", "")     # 20140901123456
        rows.append({"added": added, "ymd": ymd, "ts": ts, "title": title, "artist": artist})
    url = page.get("next")

print(f"Extracted {len(rows)} tracks from playlist {args.playlist}", file=sys.stderr)

def fsafe(s):  # strip only path-illegal chars; keep spaces/dashes like your real files
    for c in '\\/:*?"<>|': s = s.replace(c, " ")
    return s.strip()

def sqlq(s): return "'" + s.replace("'", "''") + "'"

out = open(args.out, "w", encoding="utf-8", newline="") if args.out else sys.stdout

if args.format == "csv":
    w = csv.writer(out)
    w.writerow(["position", "added_date", "title", "artist"])
    for i, r in enumerate(rows, 1):
        w.writerow([i, r["ymd"], r["title"], r["artist"]])

elif args.format == "filename":
    for i, r in enumerate(rows):
        out.write(f"{r['ymd']}_{args.start_id+i}_{fsafe(r['title'])}_{fsafe(r['artist'])}.mp3\n")

elif args.format == "sql":
    for i, r in enumerate(rows):
        out.write(
            "INSERT INTO tunes (id, ts, title, artist) VALUES "
            f"({args.start_id+i}, {r['ts'] or r['ymd']+'000000'}, {sqlq(r['title'])}, {sqlq(r['artist'])});\n"
        )

if args.out:
    out.close()
    print(f"Wrote {args.out}", file=sys.stderr)
