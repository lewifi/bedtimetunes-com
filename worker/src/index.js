/**
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

const xml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// fetch an image and inline it as a data: URI so the card is self-contained
// (standalone SVGs and many social rasterizers won't load external <image href>)
async function dataUri(url) {
  try {
    const r = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 86400 } });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || 'image/jpeg';
    const buf = new Uint8Array(await r.arrayBuffer());
    let bin = ''; const C = 0x8000;
    for (let i = 0; i < buf.length; i += C) bin += String.fromCharCode.apply(null, buf.subarray(i, i + C));
    return `data:${ct};base64,${btoa(bin)}`;
  } catch { return null; }
}

// 1200×630 social card: aurora orbs + logo tile + album art + title/artist
async function ogCard(t, artUrl) {
  const title = trunc(xml(t.title || ''), 22);
  const artist = trunc(xml((t.artist || '').toUpperCase()), 32);
  const [logo, art] = await Promise.all([
    dataUri('https://bedtimetunes.com/bedtimetunes.jpg'),
    dataUri(artUrl),
  ]);
  const artHref = art || logo;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">
<defs>
  <filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="75"/></filter>
  <clipPath id="lc"><rect x="70" y="235" width="160" height="160" rx="24"/></clipPath>
  <clipPath id="ac"><rect x="258" y="165" width="300" height="300" rx="28"/></clipPath>
  <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d0510" stop-opacity="0"/><stop offset="1" stop-color="#0d0510" stop-opacity="0.55"/></linearGradient>
</defs>
<rect width="1200" height="630" fill="#0d0510"/>
<g filter="url(#b)" opacity="0.6">
  <circle cx="170" cy="110" r="210" fill="#c2416b"/>
  <circle cx="1060" cy="80" r="220" fill="#7b2650"/>
  <circle cx="1130" cy="520" r="250" fill="#d4663a"/>
  <circle cx="640" cy="650" r="230" fill="#e0902c"/>
  <circle cx="980" cy="330" r="190" fill="#8b3a62"/>
  <circle cx="380" cy="560" r="170" fill="#b5476a"/>
</g>
<rect width="1200" height="630" fill="url(#fade)"/>
${logo ? `<image xlink:href="${logo}" x="70" y="235" width="160" height="160" clip-path="url(#lc)" preserveAspectRatio="xMidYMid slice"/>` : ''}
<rect x="70" y="235" width="160" height="160" rx="24" fill="none" stroke="#ffffff" stroke-opacity="0.14" stroke-width="2"/>
${artHref ? `<image xlink:href="${artHref}" x="258" y="165" width="300" height="300" clip-path="url(#ac)" preserveAspectRatio="xMidYMid slice"/>` : ''}
<rect x="258" y="165" width="300" height="300" rx="28" fill="none" stroke="#ffffff" stroke-opacity="0.14" stroke-width="2"/>
<text x="600" y="272" font-family="Barlow, Arial, sans-serif" font-size="60" font-weight="700" fill="#ffffff">${title}</text>
<text x="600" y="336" font-family="Barlow, Arial, sans-serif" font-size="28" letter-spacing="6" fill="#ffffff" fill-opacity="0.7">${artist}</text>
<text x="600" y="468" font-family="Barlow, Arial, sans-serif" font-size="24" letter-spacing="10" fill="#ffffff" fill-opacity="0.42">BEDTIME TUNES</text>
<text x="600" y="500" font-family="Barlow, Arial, sans-serif" font-size="14" letter-spacing="6" fill="#ffffff" fill-opacity="0.3">TUNES TO SNOOZE TO</text>
</svg>`;
}

// default site card (no specific track) — centered logo + wordmark
async function ogCardDefault() {
  const logo = await dataUri('https://bedtimetunes.com/bedtimetunes.jpg');
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">
<defs>
  <filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="80"/></filter>
  <clipPath id="lc"><rect x="500" y="120" width="200" height="200" rx="28"/></clipPath>
  <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d0510" stop-opacity="0"/><stop offset="1" stop-color="#0d0510" stop-opacity="0.5"/></linearGradient>
</defs>
<rect width="1200" height="630" fill="#0d0510"/>
<g filter="url(#b)" opacity="0.6">
  <circle cx="200" cy="120" r="230" fill="#c2416b"/>
  <circle cx="1040" cy="100" r="230" fill="#7b2650"/>
  <circle cx="1080" cy="540" r="250" fill="#d4663a"/>
  <circle cx="320" cy="560" r="220" fill="#e0902c"/>
  <circle cx="640" cy="320" r="200" fill="#8b3a62"/>
</g>
<rect width="1200" height="630" fill="url(#fade)"/>
${logo ? `<image xlink:href="${logo}" x="500" y="120" width="200" height="200" clip-path="url(#lc)" preserveAspectRatio="xMidYMid slice"/>` : ''}
<rect x="500" y="120" width="200" height="200" rx="28" fill="none" stroke="#ffffff" stroke-opacity="0.14" stroke-width="2"/>
<text x="600" y="420" text-anchor="middle" font-family="Barlow, Arial, sans-serif" font-size="58" font-weight="700" letter-spacing="6" fill="#ffffff">BEDTIME TUNES</text>
<text x="600" y="468" text-anchor="middle" font-family="Barlow, Arial, sans-serif" font-size="24" letter-spacing="10" fill="#ffffff" fill-opacity="0.55">TUNES TO SNOOZE TO</text>
</svg>`;
}

const ADD_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Add a tune · Bedtime Tunes</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500&family=Josefin+Sans:wght@200;300&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;font-family:'Josefin Sans',sans-serif}body{background:#160a1a;color:#fff;display:flex;justify-content:center;padding:2rem;min-height:100vh}
.card{width:100%;max-width:460px;background:rgba(26,10,30,.6);border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:1.6rem;display:flex;flex-direction:column;gap:.85rem}
h1{font-family:'Barlow';font-weight:500;letter-spacing:.2em;text-transform:uppercase;font-size:1rem}
.hint{font-size:.8rem;color:rgba(255,255,255,.5)}
label{font-family:'Barlow';font-size:.55rem;letter-spacing:.2em;text-transform:uppercase;color:rgba(255,255,255,.45);margin-bottom:.25rem;display:block}
input,textarea{width:100%;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:.6rem .7rem;color:#fff;font-size:.9rem;outline:none}
input[type=file]{padding:.45rem;font-size:.75rem}
button.go{background:linear-gradient(135deg,#c2416b,#7b2650);border:none;color:#fff;border-radius:100px;padding:.7rem;font-family:'Barlow';letter-spacing:.2em;text-transform:uppercase;font-size:.65rem;cursor:pointer;margin-top:.4rem}
#msg{font-size:.8rem;min-height:1.2rem;text-align:center}</style></head>
<body><div class="card"><h1>Add a tune</h1>
<p class="hint">Provide an MP3, a link, or both — plus a cover image if you have one.</p>
<div><label>Spotify or YouTube link (optional)</label><input id="url" placeholder="https://open.spotify.com/track/… or youtu.be/…"></div>
<div><label>MP3 file (optional)</label><input id="mp3" type="file" accept="audio/mpeg,.mp3"></div>
<div><label>Cover image (optional)</label><input id="image" type="file" accept="image/*"></div>
<div><label>Title</label><input id="title"></div>
<div><label>Artist</label><input id="artist"></div>
<div><label>Genre</label><input id="genre"></div>
<div><label>Description (a short blurb shown with the tune)</label><textarea id="description" rows="2"></textarea></div>
<div><label>Notes / backstory (historical)</label><textarea id="historical" rows="2"></textarea></div>
<button class="go" id="go">Add to playlist</button><div id="msg"></div></div>
<script>
var $=function(i){return document.getElementById(i)};
var TEXT=['url','title','artist','genre','description','historical'];
$('go').addEventListener('click',async function(){
  $('msg').textContent='Saving…';
  var fd=new FormData();
  TEXT.forEach(function(f){fd.append(f,$(f).value);});
  if($('mp3').files[0]) fd.append('mp3',$('mp3').files[0]);
  if($('image').files[0]) fd.append('image',$('image').files[0]);
  try{
    var r=await fetch('/api/add',{method:'POST',credentials:'include',body:fd});
    var d=await r.json();
    $('msg').textContent = r.ok ? ('Added as id '+d.id+' (by '+d.by+')') : (d.error||'Error '+r.status);
    if(r.ok){ TEXT.forEach(function(f){$(f).value='';}); $('mp3').value=''; $('image').value=''; }
  }catch(e){ $('msg').textContent='Network error'; }
});
</script></body></html>`;

const FORM_CSS = `*{box-sizing:border-box;margin:0;font-family:'Josefin Sans',sans-serif}body{background:#160a1a;color:#fff;display:flex;justify-content:center;padding:2rem;min-height:100vh}
.card{width:100%;max-width:460px;background:rgba(26,10,30,.6);border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:1.6rem;display:flex;flex-direction:column;gap:.85rem}
h1{font-family:'Barlow';font-weight:500;letter-spacing:.2em;text-transform:uppercase;font-size:1rem}
.hint{font-size:.8rem;color:rgba(255,255,255,.5)}
label{font-family:'Barlow';font-size:.55rem;letter-spacing:.2em;text-transform:uppercase;color:rgba(255,255,255,.45);margin-bottom:.25rem;display:block}
input{width:100%;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:.6rem .7rem;color:#fff;font-size:.9rem;outline:none}
input[type=file]{padding:.45rem;font-size:.75rem}
button.go{background:linear-gradient(135deg,#c2416b,#7b2650);border:none;color:#fff;border-radius:100px;padding:.7rem;font-family:'Barlow';letter-spacing:.2em;text-transform:uppercase;font-size:.65rem;cursor:pointer;margin-top:.4rem}
#msg{font-size:.8rem;min-height:1.2rem;text-align:center}`;

const NEW_USER_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Add a curator · Bedtime Tunes</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500&family=Josefin+Sans:wght@200;300&display=swap" rel="stylesheet">
<style>${FORM_CSS}</style></head>
<body><div class="card"><h1>Add a curator</h1>
<p class="hint">Links a Cloudflare Access login to the curator name shown on their tracks. They must also be added to the Access policy in Zero Trust to reach /add.</p>
<div><label>Name (shown on tracks)</label><input id="name"></div>
<div><label>Cloudflare Access email</label><input id="email" type="email" placeholder="they@example.com"></div>
<div><label>Link (optional — site/socials)</label><input id="url" placeholder="https://…"></div>
<div><label>Photo (optional, small)</label><input id="photo" type="file" accept="image/*"></div>
<button class="go" id="go">Add curator</button><div id="msg"></div></div>
<script>
var $=function(i){return document.getElementById(i)};
$('go').addEventListener('click',async function(){
  $('msg').textContent='Saving…';
  var fd=new FormData();
  ['name','email','url'].forEach(function(f){fd.append(f,$(f).value);});
  if($('photo').files[0]) fd.append('photo',$('photo').files[0]);
  try{
    var r=await fetch('/api/new-user',{method:'POST',credentials:'include',body:fd});
    var d=await r.json();
    $('msg').textContent = r.ok ? ('Added curator '+d.name+' (id '+d.id+')') : (d.error||'Error '+r.status);
    if(r.ok){ ['name','email','url'].forEach(function(f){$(f).value='';}); $('photo').value=''; }
  }catch(e){ $('msg').textContent='Network error'; }
});
</script></body></html>`;

const LANDING_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bedtime Tunes · curator tools</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500&family=Josefin+Sans:wght@200;300&display=swap" rel="stylesheet">
<style>${FORM_CSS}
.card{text-align:center;align-items:center}
a.go{display:block;text-decoration:none;width:100%}
.brand small{display:block;font-size:.5rem;letter-spacing:.3em;opacity:.4;margin-top:.4rem;text-transform:uppercase}
.back{color:rgba(255,255,255,.5);font-size:.8rem;margin-top:.6rem;text-decoration:none}.back:hover{color:#fff}</style></head>
<body><div class="card">
<h1 class="brand">Bedtime Tunes<small>curator tools</small></h1>
<p class="hint">Add tunes to the collection, or set up a new curator.</p>
<a class="go" href="/add">♪ Add a tune</a>
<a class="go" href="/new-user">＋ Add a curator</a>
<a class="back" href="https://bedtimetunes.com">← back to the player</a>
</div></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

    if (path === '/' && request.method === 'GET')
      return new Response(LANDING_PAGE, { headers: { 'content-type': 'text/html;charset=utf-8' } });

    if (path === '/add' && request.method === 'GET')
      return new Response(ADD_PAGE, { headers: { 'content-type': 'text/html;charset=utf-8' } });

    // curator admin (lock to owner: add /new-user + /api/new-user to the Access app, allow only your email;
    // optionally set OWNER_EMAIL for a second check)
    const ownerOnly = (request) => {
      const e = request.headers.get('Cf-Access-Authenticated-User-Email');
      if (!e) return 'Not behind Access';
      if (env.OWNER_EMAIL && e.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) return 'Owner only';
      return null;
    };

    if (path === '/new-user' && request.method === 'GET') {
      const bad = ownerOnly(request);
      if (bad) return new Response(bad, { status: 403 });
      return new Response(NEW_USER_PAGE, { headers: { 'content-type': 'text/html;charset=utf-8' } });
    }

    if (path === '/api/new-user' && request.method === 'POST') {
      const bad = ownerOnly(request);
      if (bad) return new Response(JSON.stringify({ error: bad }), { status: 403, headers: { ...cors(env), 'content-type': 'application/json' } });
      const form = await request.formData();
      const name = (form.get('name') || '').toString().trim();
      const cemail = (form.get('email') || '').toString().trim().toLowerCase();
      if (!name || !cemail) return new Response(JSON.stringify({ error: 'Need a name and an Access email' }), { status: 400, headers: { ...cors(env), 'content-type': 'application/json' } });
      const nid = (await env.DB.prepare(`SELECT COALESCE(MAX(id),5)+1 AS n FROM uploaders`).first()).n;
      let photo = null;
      const pf = form.get('photo');
      if (pf && pf.size) {
        if (!env.B2_KEY_ID || !env.B2_APP_KEY) return new Response(JSON.stringify({ error: 'Uploads not configured (set B2_KEY_ID/B2_APP_KEY)' }), { status: 500, headers: { ...cors(env), 'content-type': 'application/json' } });
        const ext = (pf.name.split('.').pop() || 'jpg').toLowerCase();
        const r = await putB2(env, `u${nid}.${ext}`, await pf.arrayBuffer(), CT[ext] || 'image/jpeg');
        if (r.ok) photo = `u${nid}.${ext}`;
      }
      await env.DB.prepare(`INSERT INTO uploaders (id, name, email, url, photo) VALUES (?,?,?,?,?)`)
        .bind(nid, name, cemail, (form.get('url') || '').toString() || null, photo).run();
      return Response.json({ id: nid, name, email: cemail, photo }, { headers: cors(env) });
    }

    if (path === '/api/tracks' && request.method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT t.id, t.title, t.artist, t.genre, t.description, t.historical, t.uploader_id,
                t.mp3_key, t.youtube_id, t.spotify_id, t.art_key, t.art_url, t.duration_ms,
                u.name AS uploader_name, u.url AS uploader_url, u.photo AS uploader_photo
           FROM tunes t LEFT JOIN uploaders u ON u.id = t.uploader_id
          ORDER BY t.id ASC`
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
      let uploader;
      const known = await env.DB.prepare(`SELECT id FROM uploaders WHERE email = ?`).bind(email.toLowerCase()).first();
      if (known) uploader = known.id;                       // curator added via /new-user
      else { let map = {}; try { map = JSON.parse(env.CONTRIBUTORS || '{}'); } catch {} uploader = map[email] ?? parseInt(env.DEFAULT_UPLOADER || '2', 10); }
      const nextId = (await env.DB.prepare(`SELECT COALESCE(MAX(id),146)+1 AS n FROM tunes`).first()).n;

      const ctype = request.headers.get('content-type') || '';
      let f = { title: '', artist: '', genre: '', description: '', historical: '' };
      let src = {}, mp3_key = null, art_key = null;

      if (ctype.includes('multipart/form-data')) {
        const form = await request.formData();
        for (const k of Object.keys(f)) f[k] = form.get(k) || '';
        src = parseSource(form.get('url') || '');               // link, if supplied
        const mp3 = form.get('mp3'), image = form.get('image'); // file(s), if supplied
        if ((mp3 && mp3.size) || (image && image.size)) {
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

    // share page — per-track Open Graph card, then bounce to the player
    if (path.startsWith('/s/')) {
      const id = (path.match(/\/s\/(\d+)/) || [])[1];
      const t = id && await env.DB.prepare(
        `SELECT id, title, artist, description FROM tunes WHERE id=?`).bind(id).first();
      if (!t) return Response.redirect('https://bedtimetunes.com/', 302);
      const player = `https://bedtimetunes.com/#${path.replace('/s/', '')}`;
      const title = xml(`${t.title} — ${t.artist}`);
      const desc = xml(t.description || 'A bedtime tune to snooze to.');
      const ogimg = `https://audio.bedtimetunes.com/og/${t.id}`;
      const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${title} · Bedtime Tunes</title>
<meta property="og:type" content="music.song">
<meta property="og:site_name" content="Bedtime Tunes">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${ogimg}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${player}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${ogimg}">
<meta http-equiv="refresh" content="0;url=${player}">
<script>location.replace(${JSON.stringify(player)})</script>
</head><body style="background:#0d0510;color:#fff;font-family:sans-serif;text-align:center;padding:3rem">
<p>Opening Bedtime Tunes…</p><a style="color:#e8739a" href="${player}">${title}</a></body></html>`;
      return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8', 'Cache-Control': 'public, max-age=300', ...cors(env) } });
    }

    if (path === '/og' || path.startsWith('/og/')) {
      const id = (path.match(/\/og\/(\d+)/) || [])[1];
      if (id) {
        const t = await env.DB.prepare(
          `SELECT id, title, artist, art_url, youtube_id FROM tunes WHERE id=?`).bind(id).first();
        if (t) {
          const art = t.art_url
            || (t.youtube_id ? `https://i.ytimg.com/vi/${t.youtube_id}/hqdefault.jpg` : 'https://bedtimetunes.com/bedtimetunes.jpg');
          return new Response(await ogCard(t, art), { headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400', ...cors(env) } });
        }
      }
      return new Response(await ogCardDefault(), { headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400', ...cors(env) } });
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
};