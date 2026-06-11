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
      const ref = request.headers.get('/**
 * Bedtime Tunes — audio.bedtimetunes.com Worker
 *   GET  /api/tracks            public; full list, owned-first (id asc), multi-source columns
 *   POST /api/sync              bearer; set mp3_key/youtube_id/spotify_id/duration_ms/art_url/art_key
 *   GET  /add                   Cloudflare Access; curator page (upload OR paste a link)
 *   POST /api/add               Cloudflare Access; add a track (multipart upload, or JSON link)
 *   GET  /<id>.mp3|.jpg|.png    hotlink-gated B2 proxy (Range/seek, edge-cached) — audio AND art
 *
 * Bindings: DB, ALLOWED_ORIGIN, ALLOWED_REFERER, B2_ENDPOINT, B2_BUCKET,
 *           CONTRIBUTORS (JSON {"email":uploaderId}), DEFAULT_UPLOADER
 * Secrets:  SYNC_TOKEN, B2_KEY_ID, B2_APP_KEY   (the last two only needed for /add uploads)
 */
const cors = (env) => ({
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
});

const CT = { mp3: 'audio/mpeg', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function parseSource(url) {
  let m;
  if ((m = url.match(/spotify\.com\/track\/([A-Za-z0-9]+)/))) return { spotify_id: m[1] };
  if ((m = url.match(/spotify:track:([A-Za-z0-9]+)/)))        return { spotify_id: m[1] };
  if ((m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/)))
    return { youtube_id: m[1] };
  return {};
}

// virtual-host B2 URL (path-style fails on B2 with "Unable to obtain accountId")
const b2url = (env, key) =>
  `${env.B2_ENDPOINT.replace('https://', 'https://' + env.B2_BUCKET + '.')}/${key}`;

// ---- minimal AWS SigV4 PutObject to B2 (S3-compatible) ----
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function sha256hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
}
async function putB2(env, key, body, contentType) {
  const region = (env.B2_ENDPOINT.match(/s3\.([a-z0-9-]+)\.backblazeb2/) || [])[1] || env.B2_REGION;
  const host = `${env.B2_BUCKET}.s3.${region}.backblazeb2.com`;
  const amzdate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const datestamp = amzdate.slice(0, 8);
  const uri = '/' + key.split('/').map(encodeURIComponent).join('/');
  const payloadHash = await sha256hex(new Uint8Array(body));
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = `PUT\n${uri}\n\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzdate}\n\n${signedHeaders}\n${payloadHash}`;
  const scope = `${datestamp}/${region}/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${amzdate}\n${scope}\n${await sha256hex(canonical)}`;
  let k = new TextEncoder().encode('AWS4' + env.B2_APP_KEY);
  for (const part of [datestamp, region, 's3', 'aws4_request']) k = await hmac(k, part);
  const sig = hex(await hmac(k, toSign));
  const auth = `AWS4-HMAC-SHA256 Credential=${env.B2_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  return fetch(`https://${host}${uri}`, {
    method: 'PUT',
    headers: { Authorization: auth, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzdate, 'Content-Type': contentType || 'application/octet-stream' },
    body,
  });
}

const ADD_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Add a tune · Bedtime Tunes</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500&family=Josefin+Sans:wght@200;300&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;font-family:'Josefin Sans',sans-serif}body{background:#160a1a;color:#fff;display:flex;justify-content:center;padding:2rem;min-height:100vh}
.card{width:100%;max-width:460px;background:rgba(26,10,30,.6);border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:1.6rem;display:flex;flex-direction:column;gap:.85rem}
h1{font-family:'Barlow';font-weight:500;letter-spacing:.2em;text-transform:uppercase;font-size:1rem}
label{font-family:'Barlow';font-size:.55rem;letter-spacing:.2em;text-transform:uppercase;color:rgba(255,255,255,.45);margin-bottom:.25rem;display:block}
input,textarea{width:100%;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:.6rem .7rem;color:#fff;font-size:.9rem;outline:none}
input[type=file]{padding:.45rem;font-size:.75rem}
.seg{display:flex;gap:.4rem}.seg button{flex:1;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);color:rgba(255,255,255,.6);border-radius:100px;padding:.5rem;font-family:'Barlow';letter-spacing:.18em;text-transform:uppercase;font-size:.55rem;cursor:pointer}
.seg button.on{background:rgba(194,65,107,.3);border-color:rgba(194,65,107,.7);color:#fff}
button.go{background:linear-gradient(135deg,#c2416b,#7b2650);border:none;color:#fff;border-radius:100px;padding:.7rem;font-family:'Barlow';letter-spacing:.2em;text-transform:uppercase;font-size:.65rem;cursor:pointer;margin-top:.4rem}
#msg{font-size:.8rem;min-height:1.2rem;text-align:center}.hide{display:none}</style></head>
<body><div class="card"><h1>Add a tune</h1>
<div class="seg"><button id="m-link" class="on" type="button">Paste a link</button><button id="m-up" type="button">Upload file</button></div>
<div id="link-fields"><label>Spotify or YouTube link</label><input id="url" placeholder="https://open.spotify.com/track/… or youtu.be/…"></div>
<div id="up-fields" class="hide">
  <label>MP3 file</label><input id="mp3" type="file" accept="audio/mpeg,.mp3">
  <label style="margin-top:.6rem">Cover image (optional)</label><input id="image" type="file" accept="image/*">
</div>
<div><label>Title</label><input id="title"></div>
<div><label>Artist</label><input id="artist"></div>
<div><label>Genre</label><input id="genre"></div>
<div><label>Description (a short blurb shown with the tune)</label><textarea id="description" rows="2"></textarea></div>
<div><label>Notes / backstory (historical)</label><textarea id="historical" rows="2"></textarea></div>
<button class="go" id="go">Add to playlist</button><div id="msg"></div></div>
<script>
let mode='link';
const show=()=>{link_fields.classList.toggle('hide',mode!=='link');up_fields.classList.toggle('hide',mode!=='up');
  m_link.classList.toggle('on',mode==='link');m_up.classList.toggle('on',mode==='up');};
m_link.onclick=()=>{mode='link';show();};m_up.onclick=()=>{mode='up';show();};
go.onclick=async()=>{msg.textContent='Saving…';
 const fd=new FormData();
 fd.append('mode',mode);
 fd.append('url',mode==='link'?url.value:'');
 ['title','artist','genre','description','historical'].forEach(f=>fd.append(f,window[f].value));
 if(mode==='up'){ if(mp3.files[0])fd.append('mp3',mp3.files[0]); if(image.files[0])fd.append('image',image.files[0]); }
 try{const r=await fetch('/api/add',{method:'POST',credentials:'include',body:fd});
 const d=await r.json(); msg.textContent=r.ok?('Added as id '+d.id+' (by '+d.by+')'):(d.error||'Error '+r.status);
 if(r.ok){url.value=title.value=artist.value=genre.value=description.value=historical.value='';if(mp3)mp3.value='';if(image)image.value='';}}
 catch(e){msg.textContent='Network error';}};
</script></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

    if (path === '/add' && request.method === 'GET')
      return new Response(ADD_PAGE, { headers: { 'content-type': 'text/html;charset=utf-8' } });

    if (path === '/api/tracks' && request.method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT id, title, artist, genre, description, historical, uploader_id,
                mp3_key, youtube_id, spotify_id, art_key, art_url, duration_ms
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
                            spotify_id=COALESCE(?,spotify_id), duration_ms=COALESCE(?,duration_ms),
                            art_url=COALESCE(?,art_url), art_key=COALESCE(?,art_key)
             WHERE id=?`
        ).bind(it.mp3_key ?? null, it.youtube_id ?? null, it.spotify_id ?? null,
               it.duration_ms ?? null, it.art_url ?? null, it.art_key ?? null, it.id).run();
        if (res.meta.changes) updated++; else missing.push(it.id);
      }
      return Response.json({ updated, missing }, { headers: cors(env) });
    }

    if (path === '/api/add' && request.method === 'POST') {
      const email = request.headers.get('Cf-Access-Authenticated-User-Email');
      if (!email) return new Response(JSON.stringify({ error: 'Not behind Access' }), { status: 403, headers: { ...cors(env), 'content-type': 'application/json' } });
      let map = {}; try { map = JSON.parse(env.CONTRIBUTORS || '{}'); } catch {}
      const uploader = map[email] ?? parseInt(env.DEFAULT_UPLOADER || '2', 10);
      const nextId = (await env.DB.prepare(`SELECT COALESCE(MAX(id),146)+1 AS n FROM tunes`).first()).n;

      const ctype = request.headers.get('content-type') || '';
      let f = { title: '', artist: '', genre: '', description: '', historical: '' };
      let src = {}, mp3_key = null, art_key = null;

      if (ctype.includes('multipart/form-data')) {
        const form = await request.formData();
        for (const k of Object.keys(f)) f[k] = form.get(k) || '';
        const mode = form.get('mode') || 'link';
        if (mode === 'link') {
          src = parseSource(form.get('url') || '');
        } else {
          const mp3 = form.get('mp3'), image = form.get('image');
          if (!env.B2_KEY_ID || !env.B2_APP_KEY)
            return new Response(JSON.stringify({ error: 'Uploads not configured (set B2_KEY_ID/B2_APP_KEY secrets)' }), { status: 500, headers: { ...cors(env), 'content-type': 'application/json' } });
          if (mp3 && mp3.size) {
            const r = await putB2(env, `${nextId}.mp3`, await mp3.arrayBuffer(), 'audio/mpeg');
            if (!r.ok) return new Response(JSON.stringify({ error: 'B2 mp3 upload failed (' + r.status + ')' }), { status: 502, headers: { ...cors(env), 'content-type': 'application/json' } });
            mp3_key = `${nextId}.mp3`;
          }
          if (image && image.size) {
            const ext = (image.name.split('.').pop() || 'jpg').toLowerCase();
            const r = await putB2(env, `${nextId}.${ext}`, await image.arrayBuffer(), CT[ext] || 'image/jpeg');
            if (r.ok) art_key = `${nextId}.${ext}`;
          }
        }
      } else {
        const body = await request.json().catch(() => ({}));
        f = { ...f, ...body };
        src = parseSource(body.url || '');
      }

      if (!src.spotify_id && !src.youtube_id && !mp3_key && !f.title)
        return new Response(JSON.stringify({ error: 'Need a link, an MP3, or at least a title' }), { status: 400, headers: { ...cors(env), 'content-type': 'application/json' } });

      const nowTs = Number(new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14));
      await env.DB.prepare(
        `INSERT INTO tunes (id, ts, title, artist, genre, description, historical, uploader_id,
                            mp3_key, youtube_id, spotify_id, art_key, added_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(nextId, nowTs, f.title || '(untitled)', f.artist || '', f.genre || '',
             f.description || '', f.historical || '', uploader,
             mp3_key, src.youtube_id ?? null, src.spotify_id ?? null, art_key,
             new Date().toISOString()).run();
      return Response.json({ id: nextId, by: email, uploader, mp3_key, art_key, ...src }, { headers: cors(env) });
    }

    // B2 media proxy — audio AND images, hotlink-gated + edge-cached
    const ext = (path.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
    if (ext && CT[ext]) {
      const ref = request.headers.get('Referer') || '';
      if (ref && !ref.includes(env.ALLOWED_REFERER || 'bedtimetunes.com'))
        return Response.redirect('https://bedtimetunes.com/', 302);
      const key = decodeURIComponent(path.replace(/^\/+/, ''));
      const fwd = new Headers();
      const range = request.headers.get('Range'); if (range) fwd.set('Range', range);
      const up = await fetch(b2url(env, key), { headers: fwd, cf: { cacheEverything: true, cacheTtl: 86400 } });
      if (!up.ok && up.status !== 206) return new Response('Not found', { status: up.status, headers: cors(env) });
      const h = new Headers(up.headers);
      h.set('Content-Type', CT[ext]); h.set('Accept-Ranges', 'bytes');
      h.set('Cache-Control', 'public, max-age=86400, immutable');
      h.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN || '*');
      for (const k of [...h.keys()]) if (k.toLowerCase().startsWith('x-bz')) h.delete(k);
      return new Response(up.body, { status: up.status, headers: h });
    }

    return new Response('Not found', { status: 404, headers: cors(env) });
  },
};Referer') || '';
      if (ref && !ref.includes(env.ALLOWED_REFERER || 'bedtimetunes.com'))
        return Response.redirect('https://bedtimetunes.com/', 302);
      const key = decodeURIComponent(path.replace(/^\/+/, ''));
      const fwd = new Headers();
      const range = request.headers.get('Range'); if (range) fwd.set('Range', range);
      const b2host = env.B2_ENDPOINT.replace('https://', `https://${env.B2_BUCKET}.`);
      const up = await fetch(`${b2host}/${key}`, { headers: fwd, cf: { cacheEverything: true, cacheTtl: 86400 } });      if (up.status === 404) return new Response('Not found', { status: 404, headers: cors(env) });
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
