/**
 * Bedtime Tunes — audio.bedtimetunes.com Worker
 *   GET  /api/tracks   public; full list, owned-first (id asc), multi-source columns
 *   POST /api/sync     bearer; set mp3_key / youtube_id / spotify_id / duration_ms for an id (or array)
 *   POST /api/add      Cloudflare Access; a contributor adds a track from a pasted URL
 *   GET  /<id>.mp3     hotlink-gated B2 proxy (Range/seek, edge-cached)
 *
 * Bindings: DB, ALLOWED_ORIGIN, ALLOWED_REFERER, B2_ENDPOINT, B2_BUCKET,
 *           CONTRIBUTORS (JSON {"email":uploaderId}), DEFAULT_UPLOADER
 * Secret:   SYNC_TOKEN
 */
const cors = (env) => ({
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
});

function parseSource(url) {
  let m;
  if ((m = url.match(/spotify\.com\/track\/([A-Za-z0-9]+)/))) return { spotify_id: m[1] };
  if ((m = url.match(/spotify:track:([A-Za-z0-9]+)/)))        return { spotify_id: m[1] };
  if ((m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/)))
    return { youtube_id: m[1] };
  return {};
}

const ADD_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Add a tune · Bedtime Tunes</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500&family=Josefin+Sans:wght@200;300&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;font-family:'Josefin Sans',sans-serif}body{background:#160a1a;color:#fff;display:flex;justify-content:center;padding:2rem;min-height:100vh}
.card{width:100%;max-width:440px;background:rgba(26,10,30,.6);border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:1.6rem;display:flex;flex-direction:column;gap:.9rem}
h1{font-family:'Barlow';font-weight:500;letter-spacing:.2em;text-transform:uppercase;font-size:1rem}
label{font-family:'Barlow';font-size:.55rem;letter-spacing:.2em;text-transform:uppercase;color:rgba(255,255,255,.45);margin-bottom:.25rem;display:block}
input,textarea{width:100%;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:.6rem .7rem;color:#fff;font-size:.9rem;outline:none}
button{background:linear-gradient(135deg,#c2416b,#7b2650);border:none;color:#fff;border-radius:100px;padding:.7rem;font-family:'Barlow';letter-spacing:.2em;text-transform:uppercase;font-size:.65rem;cursor:pointer;margin-top:.4rem}
#msg{font-size:.8rem;min-height:1.2rem;text-align:center}</style></head>
<body><div class="card"><h1>Add a tune</h1>
<div><label>Spotify or YouTube link</label><input id="url" placeholder="https://open.spotify.com/track/… or youtu.be/…"></div>
<div><label>Title</label><input id="title"></div>
<div><label>Artist</label><input id="artist"></div>
<div><label>Genre</label><input id="genre"></div>
<div><label>Notes (historical)</label><textarea id="historical" rows="2"></textarea></div>
<button id="go">Add to playlist</button><div id="msg"></div></div>
<script>
go.onclick=async()=>{msg.textContent='Saving…';
 const b={url:url.value,title:title.value,artist:artist.value,genre:genre.value,historical:historical.value};
 try{const r=await fetch('/api/add',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify(b)});
 const d=await r.json(); msg.textContent=r.ok?('Added as id '+d.id+' (by '+d.by+')'):(d.error||'Error '+r.status);
 if(r.ok){url.value=title.value=artist.value=genre.value=historical.value='';}}catch(e){msg.textContent='Network error';}};
</script></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

    // Add page (protect /add + /api/add with the same Cloudflare Access application)
    if (path === '/add' && request.method === 'GET')
      return new Response(ADD_PAGE, { headers: { 'content-type': 'text/html;charset=utf-8' } });

    if (path === '/api/tracks' && request.method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT id, title, artist, genre, description, uploader_id,
                mp3_key, youtube_id, spotify_id, art_key, duration_ms
           FROM tunes ORDER BY id ASC`
      ).all();
      return Response.json(results, { headers: { ...cors(env), 'Cache-Control': 'public, max-age=60' } });
    }

    if (path === '/api/sync' && request.method === 'POST') {
      if ((request.headers.get('Authorization') || '') !== `Bearer ${env.SYNC_TOKEN}`)
        return new Response('Unauthorized', { status: 401, headers: cors(env) });
      let body; try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: cors(env) }); }
      const items = Array.isArray(body) ? body : [body];
      let updated = 0; const missing = [];
      for (const it of items) {
        if (it?.id == null) continue;
        const res = await env.DB.prepare(
          `UPDATE tunes SET mp3_key=COALESCE(?,mp3_key), youtube_id=COALESCE(?,youtube_id),
                            spotify_id=COALESCE(?,spotify_id), duration_ms=COALESCE(?,duration_ms)
             WHERE id=?`
        ).bind(it.mp3_key ?? null, it.youtube_id ?? null, it.spotify_id ?? null, it.duration_ms ?? null, it.id).run();
        if (res.meta.changes) updated++; else missing.push(it.id);
      }
      return Response.json({ updated, missing }, { headers: cors(env) });
    }

    if (path === '/api/add' && request.method === 'POST') {
      const email = request.headers.get('Cf-Access-Authenticated-User-Email');
      if (!email) return new Response('Forbidden (not behind Access)', { status: 403, headers: cors(env) });
      let body; try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: cors(env) }); }
      const src = parseSource(body.url || '');
      if (!src.spotify_id && !src.youtube_id && !body.title)
        return new Response('Need a Spotify/YouTube URL or a title', { status: 400, headers: cors(env) });
      let map = {}; try { map = JSON.parse(env.CONTRIBUTORS || '{}'); } catch {}
      const uploader = map[email] ?? parseInt(env.DEFAULT_UPLOADER || '2', 10);
      const nextId = (await env.DB.prepare(`SELECT COALESCE(MAX(id),146)+1 AS n FROM tunes`).first()).n;
      const nowTs = Number(new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14));
      await env.DB.prepare(
        `INSERT INTO tunes (id, ts, title, artist, genre, description, historical, uploader_id,
                            youtube_id, spotify_id, added_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(nextId, nowTs, body.title || '(untitled)', body.artist || '', body.genre || '',
             body.description || '', body.historical || '', uploader,
             src.youtube_id ?? null, src.spotify_id ?? null, new Date().toISOString()).run();
      return Response.json({ id: nextId, by: email, uploader, ...src }, { headers: cors(env) });
    }

    if (path.endsWith('.mp3')) {
      const ref = request.headers.get('Referer') || '';
      if (ref && !ref.includes(env.ALLOWED_REFERER || 'bedtimetunes.com'))
        return Response.redirect('https://bedtimetunes.com/', 302);
      const key = decodeURIComponent(path.replace(/^\/+/, ''));
      const fwd = new Headers();
      const range = request.headers.get('Range'); if (range) fwd.set('Range', range);
      const up = await fetch(`${env.B2_ENDPOINT}/${env.B2_BUCKET}/${key}`, { headers: fwd, cf: { cacheEverything: true, cacheTtl: 86400 } });
      if (up.status === 404) return new Response('Not found', { status: 404, headers: cors(env) });
      const h = new Headers(up.headers);
      h.set('Content-Type', 'audio/mpeg'); h.set('Accept-Ranges', 'bytes');
      h.set('Cache-Control', 'public, max-age=86400, immutable');
      h.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN || '*');
      for (const k of [...h.keys()]) if (k.toLowerCase().startsWith('x-bz')) h.delete(k);
      return new Response(up.body, { status: up.status, headers: h });
    }

    return new Response('Not found', { status: 404, headers: cors(env) });
  },
};
