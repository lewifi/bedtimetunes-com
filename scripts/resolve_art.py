#!/usr/bin/env python3
"""
Resolve album art for every tune that doesn't have one yet.

Order of preference per track:
  1. Spotify album cover  (needs spotify_id + Spotify app credentials) — best quality, covers
     BOTH your owned mp3 tracks and spotify-only ones, since almost all have a spotify_id.
  2. YouTube thumbnail    (https://i.ytimg.com/vi/<id>/hqdefault.jpg) — fallback when no spotify_id.

Stores the image URL in tunes.art_url via /api/sync. Run db/alter_art_url.sql first.

  python3 resolve_art.py --base https://audio.bedtimetunes.com --token <SYNC_TOKEN> \
        --spotify-id <client_id> --spotify-secret <client_secret> --limit 2000

Get Spotify credentials (free): https://developer.spotify.com/dashboard → Create app → copy
Client ID + Client secret. No redirect URI needed (client-credentials flow).
"""
import sys, json, time, base64, argparse, urllib.request, urllib.error

ap = argparse.ArgumentParser()
ap.add_argument("--base", required=True)
ap.add_argument("--token", required=True)
ap.add_argument("--spotify-id", default="")
ap.add_argument("--spotify-secret", default="")
ap.add_argument("--limit", type=int, default=2000)
ap.add_argument("--flush-every", type=int, default=50)
args = ap.parse_args()

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
def http(url, data=None, headers=None, method=None):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})}, method=method)
    try:
        return json.loads(urllib.request.urlopen(req).read().decode())
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code} {url}: {e.read().decode(errors='replace')[:160]}", file=sys.stderr); raise

# ---- Spotify client-credentials token ----
sp_token = None
def spotify_token():
    global sp_token
    if sp_token or not (args.spotify_id and args.spotify_secret): return sp_token
    auth = base64.b64encode(f"{args.spotify_id}:{args.spotify_secret}".encode()).decode()
    res = http("https://accounts.spotify.com/api/token",
               data=b"grant_type=client_credentials",
               headers={"Authorization": "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded"})
    sp_token = res.get("access_token")
    print("got Spotify token" if sp_token else "Spotify auth FAILED", file=sys.stderr)
    return sp_token

def spotify_art(spotify_id):
    tok = spotify_token()
    if not tok: return None
    try:
        res = http(f"https://api.spotify.com/v1/tracks/{spotify_id}", headers={"Authorization": "Bearer " + tok})
        imgs = (res.get("album") or {}).get("images") or []
        return imgs[0]["url"] if imgs else None
    except Exception:
        return None

def art_for(t):
    if t.get("spotify_id"):
        a = spotify_art(t["spotify_id"])
        if a: return a
    if t.get("youtube_id"):
        return f"https://i.ytimg.com/vi/{t['youtube_id']}/hqdefault.jpg"
    return None

tracks = http(f"{args.base}/api/tracks")
todo = [t for t in tracks if not t.get("art_url")][: args.limit]
print(f"{len(todo)} tunes need art", file=sys.stderr)

def sync(items):
    if not items: return
    res = http(f"{args.base}/api/sync", data=json.dumps(items).encode(),
               headers={"Authorization": f"Bearer {args.token}", "Content-Type": "application/json"})
    print(f"  ↳ synced {len(items)}: updated={res.get('updated')} missing={res.get('missing')}", file=sys.stderr)

batch, found = [], 0
try:
    for i, t in enumerate(todo, 1):
        a = art_for(t)
        print(f"  [{i}/{len(todo)}] id={t['id']} {t['artist']} – {t['title']} -> {'ok' if a else 'none'}", file=sys.stderr)
        if a:
            found += 1
            batch.append({"id": int(t["id"]), "art_url": a})
            if len(batch) >= args.flush_every:
                sync(batch); batch = []
        time.sleep(0.05)  # be gentle on the Spotify API
finally:
    sync(batch)
print(f"art resolved for {found}/{len(todo)}", file=sys.stderr)