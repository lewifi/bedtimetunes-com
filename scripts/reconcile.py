#!/usr/bin/env python3
"""
Reconcile a Spotify playlist against your existing Bedtime Tunes catalog.

Reads your catalog straight from seed.sql (loaded into an in-memory SQLite db),
pulls the full Spotify playlist, fuzzy-matches title+artist, and reports:
  - MATCHED : playlist track already in catalog  -> reuses the legacy id
  - NEW     : in playlist, not in catalog         -> gets a fresh id (max+1, +2, ...)
  - REVIEW  : a likely-but-uncertain match         -> eyeball it
  - ORPHAN  : in catalog, not in the playlist      -> (info: maybe removed/renamed)

Auth (public playlist, client-credentials):
  export SPOTIFY_CLIENT_ID=...   SPOTIFY_CLIENT_SECRET=...

Usage:
  python3 reconcile.py --seed ../db/seed.sql [--playlist ID] [--report reconcile.csv] [--new-sql new_tracks.sql]
"""
import os, sys, csv, json, base64, sqlite3, argparse, re, unicodedata
import urllib.request, urllib.parse
from difflib import SequenceMatcher

ap = argparse.ArgumentParser()
ap.add_argument("--seed", default="../db/seed.sql")
ap.add_argument("--playlist", default="6AGKG8W0y4xezu8Cl6Rtkj")
ap.add_argument("--report", default="reconcile.csv")
ap.add_argument("--new-sql", default="new_tracks.sql")
ap.add_argument("--title-strong", type=float, default=0.85)  # >= -> match
ap.add_argument("--title-review", type=float, default=0.72)  # >= -> review
args = ap.parse_args()

# ── normalization for matching ───────────────────────────────
def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    s = s.lower()
    s = re.sub(r"\b(feat|ft|featuring|with)\b\.?", " ", s)
    s = s.replace("&", " and ")
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s)         # drop (remaster), [live], (feat …)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()

def sim(a, b):
    return SequenceMatcher(None, a, b).ratio()

def artist_ok(na, nc):
    if not na or not nc: return False
    return na in nc or nc in na or sim(na, nc) >= 0.5

# ── load catalog from seed.sql ───────────────────────────────
def load_catalog(path):
    con = sqlite3.connect(":memory:")
    con.executescript(open(path, encoding="utf-8").read())
    rows = con.execute("SELECT id, ts, title, artist FROM tunes").fetchall()
    con.close()
    return [{"id": r[0], "ts": r[1], "title": r[2], "artist": r[3],
             "nt": norm(r[2]), "na": norm(r[3])} for r in rows]

# ── pull spotify playlist ────────────────────────────────────
def http(url, data=None, headers=None):
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers or {})) as r:
        return json.loads(r.read().decode())

def fetch_playlist(pid):
    cid, sec = os.environ.get("SPOTIFY_CLIENT_ID"), os.environ.get("SPOTIFY_CLIENT_SECRET")
    if not cid or not sec:
        sys.exit("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.")
    tok = http("https://accounts.spotify.com/api/token",
               data=urllib.parse.urlencode({"grant_type": "client_credentials"}).encode(),
               headers={"Authorization": "Basic " + base64.b64encode(f"{cid}:{sec}".encode()).decode(),
                        "Content-Type": "application/x-www-form-urlencoded"})["access_token"]
    H = {"Authorization": "Bearer " + tok}
    out, url = [], (f"https://api.spotify.com/v1/playlists/{pid}/tracks"
                    "?fields=items(added_at,track(name,artists(name))),next&limit=100")
    while url:
        page = http(url, headers=H)
        for it in page.get("items", []):
            t = it.get("track")
            if not t or not t.get("name"): continue
            artist = ", ".join(a["name"] for a in t.get("artists", []) if a.get("name"))
            added = it.get("added_at") or ""
            out.append({"title": t["name"], "artist": artist, "added": added,
                        "ts": (added[:10] + added[11:19]).translate(str.maketrans("", "", "-:T Z")) or "00000000000000"})
        url = page.get("next")
    return out

# ── match ────────────────────────────────────────────────────
def best_match(sp, catalog):
    nt, na = norm(sp["title"]), norm(sp["artist"])
    # exact normalized title + plausible artist
    exact = [c for c in catalog if c["nt"] == nt and artist_ok(na, c["na"])]
    if exact:
        return exact[0], 1.0
    # fuzzy by title, artist as confirmation/tiebreak
    scored = sorted(catalog, key=lambda c: (sim(nt, c["nt"]), artist_ok(na, c["na"])), reverse=True)
    if not scored:
        return None, 0.0
    c = scored[0]
    return c, sim(nt, c["nt"])

def main():
    catalog = load_catalog(args.seed)
    by_id = {c["id"]: c for c in catalog}
    max_id = max((c["id"] for c in catalog), default=0)
    spotify = fetch_playlist(args.playlist)
    print(f"catalog={len(catalog)} rows (max id {max_id}) · playlist={len(spotify)} tracks", file=sys.stderr)

    matched_ids = set()
    results, new_tracks = [], []
    next_id = max_id + 1

    for sp in spotify:
        c, score = best_match(sp, catalog)
        if c and score >= args.title_strong and artist_ok(norm(sp["artist"]), c["na"]):
            status, mid = "MATCHED", c["id"]; matched_ids.add(c["id"])
        elif c and score >= args.title_review:
            status, mid = "REVIEW", c["id"]
        else:
            status, mid = "NEW", next_id; next_id += 1
            new_tracks.append((mid, sp))
        results.append({"status": status, "spotify_title": sp["title"], "spotify_artist": sp["artist"],
                        "match_id": mid if status != "NEW" else mid,
                        "catalog_title": by_id[c["id"]]["title"] if c else "",
                        "catalog_artist": by_id[c["id"]]["artist"] if c else "",
                        "score": round(score, 2), "added": sp["added"]})

    for c in catalog:
        if c["id"] not in matched_ids and not any(r["match_id"] == c["id"] and r["status"] in ("MATCHED", "REVIEW") for r in results):
            results.append({"status": "ORPHAN", "spotify_title": "", "spotify_artist": "",
                            "match_id": c["id"], "catalog_title": c["title"], "catalog_artist": c["artist"],
                            "score": "", "added": ""})

    # report
    with open(args.report, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["status", "match_id", "spotify_title", "spotify_artist",
                                          "catalog_title", "catalog_artist", "score", "added"])
        w.writeheader()
        order = {"NEW": 0, "REVIEW": 1, "MATCHED": 2, "ORPHAN": 3}
        for r in sorted(results, key=lambda r: (order[r["status"]], -(r["score"] or 0) if isinstance(r["score"], float) else 0)):
            w.writerow(r)

    # new-track INSERTs (extend the catalog with correct fresh ids)
    def sqlq(s): return "'" + s.replace("'", "''") + "'"
    with open(args.new_sql, "w", encoding="utf-8") as f:
        f.write("-- New tracks from Spotify not found in catalog\n")
        for mid, sp in new_tracks:
            f.write("INSERT INTO tunes (id, ts, title, artist) VALUES "
                    f"({mid}, {sp['ts']}, {sqlq(sp['title'])}, {sqlq(sp['artist'])});\n")

    from collections import Counter
    c = Counter(r["status"] for r in results)
    print(f"MATCHED={c['MATCHED']}  REVIEW={c['REVIEW']}  NEW={c['NEW']}  ORPHAN={c['ORPHAN']}", file=sys.stderr)
    print(f"wrote {args.report} and {args.new_sql} ({len(new_tracks)} new rows, ids {max_id+1}..{next_id-1})", file=sys.stderr)

if __name__ == "__main__":
    main()
