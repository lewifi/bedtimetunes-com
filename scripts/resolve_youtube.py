#!/usr/bin/env python3
"""
Resolve YouTube video IDs for tracks that have no MP3 and no youtube_id yet,
so they play full (via the YouTube embed) instead of the 30s Spotify preview.

Uses yt-dlp's search — no YouTube Data API key / quota needed.
  pip install yt-dlp

  python3 resolve_youtube.py --base https://audio.bedtimetunes.com --token <SYNC_TOKEN> [--limit 100]

Re-run in batches; already-resolved tracks are skipped. Eyeball the results in the
player and fix wrong picks via the /add page (paste the correct YouTube URL).
"""
import json, sys, argparse, subprocess, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--base", required=True)
ap.add_argument("--token", required=True)
ap.add_argument("--limit", type=int, default=100)
args = ap.parse_args()

def http(url, data=None, headers=None):
    h = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
         **(headers or {})}
    req = urllib.request.Request(url, data=data, headers=h)
    try:
        return json.loads(urllib.request.urlopen(req).read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        print(f"   HTTP {e.code} from {url}: {body[:200]}", file=sys.stderr)
        raise

def yt_search(query):
    # yt-dlp returns flat search results as JSON lines; take the first id
    try:
        out = subprocess.run(
            ["yt-dlp", "--flat-playlist", "--no-warnings", "-J", f"ytsearch1:{query}"],
            capture_output=True, text=True, timeout=40)
        data = json.loads(out.stdout or "{}")
        entries = data.get("entries") or []
        return entries[0]["id"] if entries else None
    except Exception as e:
        print(f"   yt-dlp error: {e}", file=sys.stderr); return None

tracks = http(f"{args.base}/api/tracks")
# verify yt-dlp is actually available — otherwise every track silently MISSes
try:
    v = subprocess.run(["yt-dlp", "--version"], capture_output=True, text=True, timeout=20)
    print(f"yt-dlp {v.stdout.strip()}", file=sys.stderr)
except FileNotFoundError:
    sys.exit("yt-dlp not found on PATH. Install it:  pip install yt-dlp   (then reopen the shell)")
todo = [t for t in tracks if not t.get("youtube_id")][: args.limit]   # incl. owned mp3 tracks → youtube-first
print(f"{len(todo)} tracks to resolve (cap {args.limit})", file=sys.stderr)

FLUSH_EVERY = 25
def sync(items):
    if not items: return
    res = http(f"{args.base}/api/sync", data=json.dumps(items).encode(),
               headers={"Authorization": f"Bearer {args.token}", "Content-Type": "application/json"})
    print(f"  ↳ synced batch of {len(items)}: updated={res.get('updated')} missing={res.get('missing')}", file=sys.stderr)

batch, found = [], 0
try:
    for i, t in enumerate(todo, 1):
        vid = yt_search(f"{t['artist']} {t['title']}")
        print(f"  [{i}/{len(todo)}] id={t['id']} {t['artist']} – {t['title']} -> {vid or 'MISS'}", file=sys.stderr)
        if vid:
            found += 1
            batch.append({"id": int(t["id"]), "youtube_id": vid})
            if len(batch) >= FLUSH_EVERY:
                sync(batch); batch = []
finally:
    sync(batch)   # flush whatever's pending — runs even on Ctrl-C
print(f"resolved {found}/{len(todo)} (rest had no YouTube hit)", file=sys.stderr)