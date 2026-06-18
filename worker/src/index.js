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

import { Resvg, initWasm } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';

// PNG rasterizer for OG cards. wasm is bundled (no runtime fetch); the Barlow font
// is fetched once from GitHub and edge-cached. Any failure → caller falls back to SVG.
let _resvgReady = null, _fontBuf = null;
async function ensureResvg() {
  if (!_resvgReady) _resvgReady = initWasm(resvgWasm);
  await _resvgReady;
  if (!_fontBuf) {
    try {
      const f = await fetch('https://raw.githubusercontent.com/google/fonts/main/ofl/barlow/Barlow-Medium.ttf', { cf: { cacheEverything: true, cacheTtl: 2592000 } });
      if (f.ok) _fontBuf = new Uint8Array(await f.arrayBuffer());
    } catch (e) {}
  }
}
async function svgToPng(svg) {
  await ensureResvg();
  const opts = { fitTo: { mode: 'width', value: 1200 } };
  if (_fontBuf) opts.font = { fontBuffers: [_fontBuf], loadSystemFonts: false, defaultFontFamily: 'Barlow' };
  return new Resvg(svg, opts).render().asPng();
}

// crawlers/link-unfurlers that shouldn't count as visitors
function isBot(ua) {
  return /bot|crawl|spider|preview|facebookexternalhit|slackbot|discord|telegram|whatsapp|embedly|bingbot|twitterbot|linkedin|pinterest|redditbot|headless|monitor|uptime|curl|wget|python-requests|axios|node-fetch|go-http|googleimageproxy|feedfetcher|apple-?mail|mediapartners/i.test(ua || '');
}
// anonymous, stable visitor id — one-way hash of ip+ua+salt; the raw IP is never stored
async function visitorId(request, env) {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const ua = request.headers.get('User-Agent') || '';
    const data = new TextEncoder().encode(`${ip}|${ua}|${env.ANALYTICS_SALT || 'bt-anon-salt'}`);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(buf)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) { return null; }
}
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
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BedtimeTunesOG/1.0)', 'Accept': 'image/*' }, cf: { cacheEverything: true, cacheTtl: 86400 } });
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
<text x="600" y="308" font-family="Barlow, Arial, sans-serif" font-size="60" font-weight="700" fill="#ffffff">${title}</text>
<text x="600" y="350" font-family="Barlow, Arial, sans-serif" font-size="28" letter-spacing="6" fill="#ffffff" fill-opacity="0.7">${artist}</text>
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

// shared by /og (SVG) and /og.png (PNG) — builds the right card for an id (or default)
async function buildOgSvg(env, id) {
  if (id) {
    const t = await env.DB.prepare(`SELECT id, title, artist, art_url, art_key, youtube_id FROM tunes WHERE id=?`).bind(id).first();
    if (t) {
      const art = t.art_url
        || (t.art_key ? `https://audio.bedtimetunes.com/${t.art_key}` : null)
        || (t.youtube_id ? `https://i.ytimg.com/vi/${t.youtube_id}/hqdefault.jpg` : null)
        || 'https://bedtimetunes.com/bedtimetunes.jpg';
      return await ogCard(t, art);
    }
  }
  return await ogCardDefault();
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
<body><div class="card"><a class="back top" href="/admin">← back to admin</a><h1>Add a tune</h1>
<p class="hint">Provide an MP3, a link, or both — plus a cover image if you have one.</p>
<div><label>Spotify or YouTube link (optional)</label><input id="url" placeholder="https://open.spotify.com/track/… or youtu.be/…"></div>
<div><label>MP3 file (optional)</label><input id="mp3" type="file" accept="audio/mpeg,.mp3"></div>
<div><label>Cover image (optional)</label><input id="image" type="file" accept="image/*"></div>
<div><label>Title</label><input id="title"></div>
<div><label>Artist</label><input id="artist"></div>
<div><label>Genre</label><input id="genre"></div>
<div><label>Description (a short blurb shown with the tune)</label><textarea id="description" rows="2"></textarea></div>
<div><label>Notes / backstory (historical)</label><textarea id="historical" rows="2"></textarea></div>
<label style="display:flex;align-items:center;gap:.5rem;text-transform:none;letter-spacing:0;font-size:.85rem;color:rgba(255,255,255,.75)"><input type="checkbox" id="notify" checked style="width:auto"> Email subscribers about this new tune</label>
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
  if($('notify').checked) fd.append('notify','1');
  try{
    var r=await fetch('/api/add',{method:'POST',credentials:'include',body:fd,redirect:'manual'});
    if(r.type==='opaqueredirect'||r.status===0){ $('msg').textContent='Your session expired — reload this page to sign in again.'; return; }
    var t=await r.text(),d={};try{d=JSON.parse(t)}catch(e){}
    if(r.ok){ $('msg').textContent='Added as id '+d.id+' (by '+d.by+')'+(d.notified?' · subscribers emailed':''); TEXT.forEach(function(f){$(f).value='';}); $('mp3').value=''; $('image').value=''; }
    else $('msg').textContent=(d.error||('Error '+r.status+(t?' — '+t.slice(0,100):'')));
  }catch(e){ $('msg').textContent='Request failed: '+(e&&e.message?e.message:e); }
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
a.go{display:block;text-align:center;text-decoration:none;background:rgba(255,255,255,.05);border:1px solid rgba(194,65,107,.5);color:rgba(255,255,255,.85);border-radius:100px;padding:.7rem;font-family:'Barlow';letter-spacing:.2em;text-transform:uppercase;font-size:.65rem;transition:all .2s}
a.go:hover{background:rgba(194,65,107,.25);border-color:rgba(194,65,107,.85);color:#fff}
.back{color:rgba(255,255,255,.5);text-decoration:none;font-size:.8rem}
.back:hover{color:#fff}
.back.top{align-self:flex-start;margin-bottom:.5rem}
#msg{font-size:.8rem;min-height:1.2rem;text-align:center}`;

function newUserPage(c) {
  const v = (s) => xml(s || '');
  const editing = !!c;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${editing ? 'Edit' : 'Add'} curator · Bedtime Tunes</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500&family=Josefin+Sans:wght@200;300&display=swap" rel="stylesheet">
<style>${FORM_CSS}
.preview{display:none;margin:.3rem auto;width:120px;height:120px;border-radius:14px;object-fit:cover;border:1px solid rgba(255,255,255,.15)}
.preview.show{display:block}</style></head>
<body><div class="card"><a class="back top" href="/admin/curators">← back to curators</a><h1>${editing ? 'Edit curator' : 'Add a curator'}</h1>
<p class="hint">Links a Cloudflare Access login to the curator name shown on their tracks. They must also be added to the Access policy in Zero Trust to reach /add.</p>
${editing ? `<input type="hidden" id="cid" value="${c.id}">` : ''}
<div><label>Name (shown on tracks)</label><input id="name" value="${v(c && c.name)}"></div>
<div><label>Location (shown on tracks)</label><input id="location" placeholder="e.g. Berlin, DE" value="${v(c && c.location)}"></div>
<div><label>Cloudflare Access email</label><input id="email" type="email" placeholder="they@example.com" value="${v(c && c.email)}"></div>
<div><label>Link (optional — site/socials)</label><input id="url" placeholder="https://…" value="${v(c && c.url)}"></div>
<div><label>Photo (optional — auto-cropped to a 200×200 square)</label><input id="photo" type="file" accept="image/*"></div>
<img id="preview" class="preview ${c && c.photo ? 'show' : ''}" alt="" src="${c && c.photo ? `https://audio.bedtimetunes.com/${c.photo}` : ''}">
<button class="go" id="go">${editing ? 'Save changes' : 'Add curator'}</button><div id="msg"></div></div>
<script>
var $=function(i){return document.getElementById(i)};
function cropSquare(file,size){return new Promise(function(res,rej){
  var img=new Image();
  img.onload=function(){
    var s=Math.min(img.width,img.height),sx=(img.width-s)/2,sy=(img.height-s)/2;
    var c=document.createElement('canvas');c.width=size;c.height=size;
    var ctx=c.getContext('2d');ctx.imageSmoothingQuality='high';
    ctx.drawImage(img,sx,sy,s,s,0,0,size,size);
    c.toBlob(function(b){URL.revokeObjectURL(img.src);res(b);},'image/jpeg',0.9);
  };
  img.onerror=function(){URL.revokeObjectURL(img.src);rej(new Error('bad image'));};
  img.src=URL.createObjectURL(file);
});}
$('photo').addEventListener('change',async function(){
  var f=$('photo').files[0];if(!f){return;}
  try{var b=await cropSquare(f,200);$('preview').src=URL.createObjectURL(b);$('preview').classList.add('show');}catch(e){}
});
$('go').addEventListener('click',async function(){
  if(!$('name').value||!$('email').value){$('msg').textContent='Name and Access email required';return;}
  $('msg').textContent='Saving…';
  var fd=new FormData();
  ['name','location','email','url'].forEach(function(f){fd.append(f,$(f).value);});
  if($('cid')) fd.append('id',$('cid').value);
  var pf=$('photo').files[0];
  if(pf){ try{var blob=await cropSquare(pf,200);fd.append('photo',blob,'photo.jpg');}catch(e){fd.append('photo',pf);} }
  try{
    var r=await fetch('/admin/api/new-user',{method:'POST',credentials:'include',body:fd,redirect:'manual'});
    if(r.type==='opaqueredirect'||r.status===0){$('msg').textContent='Session expired — reload to sign in again.';return;}
    var d=await r.json();
    if(r.ok){ $('msg').textContent=(d.updated?'Updated ':'Added ')+'curator '+d.name+' (id '+d.id+')'+(d.note?' — '+d.note:''); setTimeout(function(){location.href='/admin/curators';},900); }
    else $('msg').textContent=(d.error||'Error '+r.status);
  }catch(e){ $('msg').textContent='Request failed: '+(e&&e.message?e.message:e); }
});
</script></body></html>`;
}

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
<a class="go" href="/admin">⚙ Admin</a>
<a class="back" href="https://bedtimetunes.com">← back to the player</a>
</div></body></html>`;

const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const newToken = () => crypto.randomUUID().replace(/-/g, '');

// send one templated email to every active subscriber (graceful no-op if EMAIL unset)
async function emailList(env, subject, render) {
  if (!env.EMAIL) return { sent: 0, total: 0, note: 'EMAIL binding not configured' };
  const { results } = await env.DB.prepare(`SELECT email, token FROM subscribers WHERE COALESCE(unsubscribed,0)=0 AND COALESCE(bounced,0)=0`).all();
  let sent = 0;
  const addr = env.MAIL_FROM || 'tunes@bedtimetunes.com';
  const from = addr.includes('<') ? addr : `Bedtime Tunes <${addr}>`;
  for (const s of results) {
    const unsub = `https://audio.bedtimetunes.com/unsubscribe?t=${s.token}`;
    const { html, text } = render(s, unsub);
    try { await env.EMAIL.send({ from, to: s.email, subject, html, text }); sent++; } catch (e) {}
  }
  return { sent, total: results.length };
}

function mailShell(inner, unsub, pixel) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#0d0510">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0d0510"><tr><td align="center" style="padding:28px 16px">
<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#160a1a;border:1px solid #2a1830;border-radius:16px">
<tr><td style="padding:24px 28px 0;font-family:Arial,sans-serif">
<img src="https://bedtimetunes.com/bedtimetunes.jpg" width="40" height="40" alt="Bedtime Tunes" style="vertical-align:middle;border-radius:10px;margin-right:10px">
<span style="font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#c2416b;font-weight:bold;vertical-align:middle">Bedtime Tunes</span></td></tr>
<tr><td style="padding:16px 28px 26px;font-family:Arial,sans-serif;color:#e8dce8;font-size:15px;line-height:1.6">${inner}</td></tr>
<tr><td style="padding:0 28px 24px;font-family:Arial,sans-serif;color:#6b5b6b;font-size:11px;line-height:1.5">You're receiving this because you subscribed to Bedtime Tunes updates.<br><a href="${unsub}" style="color:#9a6b85">Unsubscribe</a></td></tr>
${pixel ? `<tr><td style="font-size:0;line-height:0"><img src="https://audio.bedtimetunes.com/o.gif?${pixel}" width="1" height="1" alt="" style="display:block;border:0"></td></tr>` : ''}
</table></td></tr></table></body></html>`;
}

function newSongEmail(track, unsub) {
  const play = `https://audio.bedtimetunes.com/s/${track.id}-${slugify(track.artist)}-${slugify(track.title)}`;
  const click = `https://audio.bedtimetunes.com/r?e=email_click&t=${track.id}&u=${encodeURIComponent(play)}`;
  const cover = track.art ? `<div style="text-align:center;margin:0 0 18px"><a href="${click}"><img src="${track.art}" width="200" height="200" alt="" style="border-radius:14px;border:1px solid #2a1830;max-width:200px;height:auto"></a></div>` : '';
  const inner = `<p style="margin:0 0 8px;color:#9a8a9a;font-size:12px;letter-spacing:2px;text-transform:uppercase">A new tune was added</p>
${cover}<h1 style="margin:0 0 4px;font-size:24px;color:#ffffff">${xml(track.title)}</h1>
<p style="margin:0 0 22px;color:#b9a9b9;font-size:14px;letter-spacing:1px">${xml(track.artist)}</p>
<a href="${click}" style="display:inline-block;background:#c2416b;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:100px;font-size:13px;letter-spacing:2px;text-transform:uppercase">&#9654; Listen now</a>`;
  return { html: mailShell(inner, unsub, `t=${track.id}`), text: `A new tune on Bedtime Tunes:\n${track.title} — ${track.artist}\n\nListen: ${play}\n\nUnsubscribe: ${unsub}` };
}

function broadcastEmail(body, unsub) {
  const safe = xml(body).replace(/\n/g, '<br>');
  return { html: mailShell(`<div style="font-size:15px;line-height:1.6;color:#e8dce8">${safe}</div>`, unsub, 'c=broadcast'), text: `${body}\n\nUnsubscribe: ${unsub}` };
}

function adminPage(count) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin · Bedtime Tunes</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500&family=Josefin+Sans:wght@200;300&display=swap" rel="stylesheet">
<style>${FORM_CSS}
a.go{display:block;text-decoration:none;text-align:center}
.row{display:flex;gap:.5rem}.row a{flex:1}
textarea{width:100%;min-height:120px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:.6rem .7rem;color:#fff;font-family:'Josefin Sans',sans-serif;font-size:.9rem;outline:none}
hr{border:none;border-top:1px solid rgba(255,255,255,.1);margin:.3rem 0}
.back{color:rgba(255,255,255,.5);text-decoration:none;font-size:.8rem;text-align:center}</style></head>
<body><div class="card"><a class="back top" href="https://bedtimetunes.com">← back to the player</a><h1>Admin</h1>
<a class="go" href="/add">♪ Add a tune</a>
<div class="row"><a class="go" href="/admin/new-user">＋ Add curator</a><a class="go" href="/admin/curators">👤 Curators</a></div>
<div class="row"><a class="go" href="/admin/users">👥 Subscribers (${count})</a><a class="go" href="/admin/stats">📊 Stats</a></div>
<hr>
<p class="hint">Broadcast a custom email to all ${count} subscribers.</p>
<div><label>Subject</label><input id="subject"></div>
<div><label>Message</label><textarea id="body"></textarea></div>
<button class="go" id="send">Send broadcast</button><div id="msg"></div>
<a class="back" href="/admin/preview" target="_blank" style="margin-bottom:.2rem">✉ preview the new-song email</a>
<hr>
<p class="hint">Import subscribers — paste emails (any format) or choose a .csv file. Only add people who opted in.</p>
<div><textarea id="csv" placeholder="alice@example.com, bob@example.com …" style="min-height:80px"></textarea></div>
<input id="csvfile" type="file" accept=".csv,text/csv,text/plain" style="color:rgba(255,255,255,.6);font-size:.8rem">
<button class="go" id="import">Import CSV</button><div id="imsg"></div>
<a class="back" href="https://bedtimetunes.com">← back to the player</a></div>
<script>
var $=function(i){return document.getElementById(i)};
async function post(url,fd,el){
  el.textContent='Working…';
  try{
    var r=await fetch(url,{method:'POST',credentials:'include',body:fd,redirect:'manual'});
    if(r.type==='opaqueredirect'||r.status===0){el.textContent='Your admin session expired — reload this page to sign in again.';return null;}
    var t=await r.text(),d={};try{d=JSON.parse(t)}catch(e){}
    if(!r.ok){el.textContent=d.error?d.error:('Error '+r.status+' — '+t.slice(0,100));return null;}
    return d;
  }catch(e){el.textContent='Request failed: '+(e&&e.message?e.message:e);return null;}
}
$('send').addEventListener('click',async function(){
  if(!$('subject').value||!$('body').value){$('msg').textContent='Subject and message required';return;}
  if(!confirm('Send to ${count} subscribers?'))return;
  var fd=new FormData();fd.append('subject',$('subject').value);fd.append('body',$('body').value);
  var d=await post('/admin/api/broadcast',fd,$('msg'));
  if(d)$('msg').textContent='Sent to '+d.sent+' of '+d.total;
});
$('import').addEventListener('click',async function(){
  var file=$('csvfile').files[0],fd=new FormData();
  if(file)fd.append('file',file);else fd.append('csv',$('csv').value);
  if(!file&&!$('csv').value.trim()){$('imsg').textContent='Paste emails or choose a file';return;}
  var d=await post('/admin/api/import',fd,$('imsg'));
  if(d)$('imsg').textContent='Added '+d.added+', skipped '+d.skipped+' duplicate(s) — '+d.parsed+' valid email(s) found';
});
</script></body></html>`;
}

function statsPage(d) {
  const card = (v, l, sub) => `<div class="stat"><div class="num">${v}</div><div class="lbl">${l}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const ppv = d.vis7 ? (d.plays7 / d.vis7).toFixed(1) : '0';
  const trackRows = (arr) => arr.length ? arr.map(r => `<tr><td>${r.title ? xml(r.title) : '#' + (r.track_id ?? '—')}</td><td class="dim">${r.artist ? xml(r.artist) : ''}</td><td class="r">${r.n}</td></tr>`).join('') : '<tr><td colspan="3" class="dim">No data yet.</td></tr>';
  const maxD = Math.max(1, ...d.daily.map(x => x.plays));
  const bars = d.daily.length ? d.daily.map(x => `<div class="bar"><div class="fill" style="height:${Math.max(2, Math.round(x.plays / maxD * 100))}%" title="${x.d}: ${x.plays} plays, ${x.vis} visitors"></div><div class="bx">${x.d.slice(8)}</div></div>`).join('') : '<div class="dim" style="padding:1rem">No data in the last 14 days.</div>';
  const rowsKV = (arr, k) => arr.length ? arr.map(r => `<tr><td>${xml(String(r[k] || '—'))}</td><td class="r">${r.n}</td></tr>`).join('') : '<tr><td colspan="2" class="dim">—</td></tr>';
  const recent = d.recent.map(r => `<tr><td class="dim">${(r.ts || '').slice(0, 16).replace('T', ' ')}</td><td>${r.type}</td><td>${r.track_id ?? ''}</td><td class="dim">${r.meta ? xml(r.meta) : ''}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stats · Bedtime Tunes</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;700&family=Josefin+Sans:wght@200;300&display=swap" rel="stylesheet">
<style>${FORM_CSS}
.card{max-width:860px}
.stats{display:flex;flex-wrap:wrap;gap:.6rem;width:100%}
.stat{flex:1;min-width:120px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:.8rem}
.stat .num{font-family:'Barlow';font-weight:700;font-size:1.6rem;color:#fff}
.stat .lbl{font-family:'Barlow';font-size:.5rem;letter-spacing:.15em;text-transform:uppercase;color:rgba(255,255,255,.45);margin-top:.2rem}
.stat .sub{font-size:.7rem;color:rgba(255,255,255,.35);margin-top:.15rem}
h2{font-family:'Barlow';font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;color:rgba(255,255,255,.5);margin:1.4rem 0 .5rem;width:100%}
table{width:100%;border-collapse:collapse;font-size:.82rem}
th,td{text-align:left;padding:.4rem .55rem;border-bottom:1px solid rgba(255,255,255,.08)}
td.r,th.r{text-align:right}
.dim{color:rgba(255,255,255,.4)}
.chart{display:flex;align-items:flex-end;gap:4px;height:130px;width:100%;padding-top:.5rem}
.bar{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%}
.fill{width:100%;max-width:26px;background:linear-gradient(180deg,#c2416b,#7b2650);border-radius:4px 4px 0 0;min-height:2px}
.bx{font-size:.5rem;color:rgba(255,255,255,.35);margin-top:.25rem}
.cols{display:flex;gap:1.2rem;flex-wrap:wrap}.cols>div{flex:1;min-width:240px}
.note{font-size:.7rem;color:rgba(255,255,255,.4);margin-top:.3rem}
.back{color:rgba(255,255,255,.5);text-decoration:none;font-size:.8rem;display:inline-block;margin-top:1.2rem}</style></head>
<body><div class="card"><a class="back top" href="/admin">← back to admin</a><h1>Stats</h1>
<p class="hint">Anonymous — counts unique visitors by a hashed id, no IPs stored. Bots &amp; link-preview bots are excluded.</p>
<h2>Last 7 days</h2>
<div class="stats">
${card(d.vis7, 'visitors', `${d.visToday} today`)}
${card(d.pv7, 'page views', `${d.pvToday} today`)}
${card(d.plays7, 'plays', `${d.playsToday} today`)}
${card(ppv, 'plays / visitor')}
${card(d.shares7, 'shares')}
${card(d.subs7, 'new subscribers')}
</div>
<h2>Plays per day · last 14 days</h2>
<div class="chart">${bars}</div>
<h2>Most played · all time</h2>
<table><thead><tr><th>Title</th><th>Artist</th><th class="r">Plays</th></tr></thead><tbody>${trackRows(d.topPlays)}</tbody></table>
<div class="cols">
<div><h2>Most shared</h2><table><tbody>${d.topShares.length ? d.topShares.map(r => `<tr><td>${r.title ? xml(r.title) : '#' + (r.track_id ?? '—')}</td><td class="r">${r.n}</td></tr>`).join('') : '<tr><td class="dim">—</td></tr>'}</tbody></table></div>
<div><h2>Listening source</h2><table><tbody>${rowsKV(d.sources, 'meta')}</tbody></table></div>
<div><h2>Top countries</h2><table><tbody>${rowsKV(d.countries, 'country')}</tbody></table></div>
</div>
<h2>Email</h2>
<div class="stats">
${card(d.emailClicks, 'clicks')}
${card(d.emailOpens, 'opens')}
</div>
<p class="note">Opens are approximate — Apple/Gmail pre-load images, so treat clicks as the reliable signal. Click tracking covers the new-tune emails.</p>
<h2>Subscribers</h2>
<div class="stats">
${card(d.subActive, 'active')}
${card(d.subUnsub, 'unsubscribed')}
${card(d.subBounce, 'bounced')}
${card(d.visAll, 'visitors all-time')}
${card(d.playsAll, 'plays all-time')}
</div>
<details style="margin-top:1.2rem"><summary class="dim" style="cursor:pointer;font-size:.8rem">Recent activity</summary>
<table style="margin-top:.5rem"><thead><tr><th>When (UTC)</th><th>Event</th><th>Track</th><th>Meta</th></tr></thead><tbody>${recent || '<tr><td colspan="4" class="dim">Nothing yet.</td></tr>'}</tbody></table></details>
<a class="back" href="/admin">← back to admin</a></div></body></html>`;
}

function curatorsPage(rows) {
  const trs = rows.map(r => `<tr data-id="${r.id}">
<td>${r.photo ? `<img src="https://audio.bedtimetunes.com/${r.photo}" width="40" height="40" style="border-radius:8px;object-fit:cover;display:block">` : '<span class="dim">—</span>'}</td>
<td>${xml(r.name)}</td>
<td class="dim">${xml(r.location || '')}</td>
<td class="dim">${xml(r.email || '')}</td>
<td>${r.url ? `<a href="${xml(r.url)}" target="_blank" rel="noopener" style="color:#e8739a">link ↗</a>` : ''}</td>
<td class="r">${r.tracks}</td>
<td style="white-space:nowrap"><a class="act" href="/admin/new-user?id=${r.id}">edit</a> <button class="act danger" data-del="${r.id}">delete</button></td></tr>`).join('') || '<tr><td colspan="7" class="dim">No curators yet.</td></tr>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Curators · Bedtime Tunes</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500&family=Josefin+Sans:wght@200;300&display=swap" rel="stylesheet">
<style>${FORM_CSS}
.card{max-width:820px}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th,td{text-align:left;padding:.5rem .55rem;border-bottom:1px solid rgba(255,255,255,.08);vertical-align:middle}
td.r,th.r{text-align:right}
th{font-family:'Barlow';font-size:.55rem;letter-spacing:.15em;text-transform:uppercase;color:rgba(255,255,255,.45)}
.dim{color:rgba(255,255,255,.4)}
.act{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.7);border-radius:7px;font-size:.7rem;padding:.2rem .5rem;cursor:pointer;text-decoration:none}
.act:hover{background:rgba(255,255,255,.12);color:#fff}
.act.danger:hover{background:rgba(194,65,107,.3);border-color:rgba(194,65,107,.7)}</style></head>
<body><div class="card"><a class="back top" href="/admin">← back to admin</a><h1>Curators</h1>
<p class="hint">${rows.length} curator${rows.length === 1 ? '' : 's'}. Counts are tracks credited to each.</p>
<table><thead><tr><th></th><th>Name</th><th>Location</th><th>Access email</th><th>Link</th><th class="r">Tracks</th><th></th></tr></thead><tbody>${trs}</tbody></table>
<a class="go" href="/admin/new-user" style="margin-top:1rem">＋ Add a curator</a></div>
<script>
document.querySelectorAll('[data-del]').forEach(function(b){b.addEventListener('click',async function(){
  var id=b.getAttribute('data-del');
  if(!confirm('Delete this curator? Their tracks stay but lose the credit.'))return;
  b.textContent='…';
  var fd=new FormData();fd.append('id',id);
  try{var r=await fetch('/admin/api/curator-delete',{method:'POST',credentials:'include',body:fd,redirect:'manual'});
    if(r.type==='opaqueredirect'||r.status===0){alert('Session expired — reload to sign in again.');return;}
    if(r.ok)location.reload();else alert('Error '+r.status);
  }catch(e){alert('Request failed: '+e.message);}
});});
</script></body></html>`;
}

function usersPage(rows) {
  const status = (r) => r.bounced ? '<span style="color:#caa15a">bounced</span>' : (r.unsubscribed ? '<span style="color:#9a6b6b">unsubscribed</span>' : '<span style="color:#7bbf7b">active</span>');
  const trs = rows.map(r => `<tr data-id="${r.id}"><td>${r.id}</td><td>${xml(r.email)}</td><td>${(r.created_at || '').slice(0, 10)}</td><td>${status(r)}</td>
<td style="white-space:nowrap">${(r.unsubscribed || r.bounced) ? `<button class="act" data-a="restore">restore</button>` : `<button class="act" data-a="bounce">bounce</button>`} <button class="act danger" data-a="remove">remove</button></td></tr>`).join('');
  const active = rows.filter(r => !r.unsubscribed && !r.bounced).length;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Subscribers · Bedtime Tunes</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500&family=Josefin+Sans:wght@200;300&display=swap" rel="stylesheet">
<style>${FORM_CSS}
.card{max-width:760px}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid rgba(255,255,255,.08)}
th{font-family:'Barlow';font-size:.55rem;letter-spacing:.15em;text-transform:uppercase;color:rgba(255,255,255,.45)}
.act{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.7);border-radius:7px;font-size:.7rem;padding:.2rem .5rem;cursor:pointer}
.act:hover{background:rgba(255,255,255,.12);color:#fff}
.act.danger:hover{background:rgba(194,65,107,.3);border-color:rgba(194,65,107,.7)}
.back{color:rgba(255,255,255,.5);text-decoration:none;font-size:.8rem}</style></head>
<body><div class="card"><a class="back top" href="/admin">← back to admin</a><h1>Subscribers</h1>
<p class="hint">${active} active · ${rows.length} total</p>
<table><thead><tr><th>#</th><th>Email</th><th>Joined</th><th>Status</th><th></th></tr></thead><tbody>${trs || '<tr><td colspan="5" style="color:rgba(255,255,255,.4)">No subscribers yet.</td></tr>'}</tbody></table>
<a class="back" href="/admin">← back to admin</a></div>
<script>
document.querySelectorAll('.act').forEach(function(b){b.addEventListener('click',async function(){
  var tr=b.closest('tr'),id=tr.getAttribute('data-id'),a=b.getAttribute('data-a');
  if(a==='remove'&&!confirm('Remove this subscriber permanently?'))return;
  b.textContent='…';
  var fd=new FormData();fd.append('id',id);fd.append('action',a);
  try{var r=await fetch('/admin/api/subscriber',{method:'POST',credentials:'include',body:fd,redirect:'manual'});
    if(r.type==='opaqueredirect'||r.status===0){alert('Session expired — reload to sign in again.');return;}
    if(r.ok)location.reload();else alert('Error '+r.status);
  }catch(e){alert('Request failed: '+e.message);}
});});
</script></body></html>`;
}

export default {
  async email(message, env, ctx) {
    // Auto-suppress bounced addresses. Route your sender/bounce address to this
    // Worker via Email Routing, and hard-bounce DSNs will mark subscribers bounced.
    try {
      const raw = await new Response(message.raw).text();
      // pull the failed recipient from common DSN headers, else any address in the body
      const m = raw.match(/(?:Final-Recipient|Original-Recipient|X-Failed-Recipients)\s*:\s*(?:rfc822;)?\s*([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})/i)
        || raw.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i);
      if (m) {
        const bad = (m[1] || m[0]).toLowerCase();
        await env.DB.prepare(`UPDATE subscribers SET bounced=1 WHERE lower(email)=?`).bind(bad).run();
      }
    } catch (e) {}
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

    if (path === '/' && request.method === 'GET')
      return new Response(LANDING_PAGE, { headers: { 'content-type': 'text/html;charset=utf-8' } });

    if (path === '/add' && request.method === 'GET')
      return new Response(ADD_PAGE, { headers: { 'content-type': 'text/html;charset=utf-8' } });

    // curator admin (all owner tools live under /admin/* — one Access include path "/admin" covers them;
    // optionally set OWNER_EMAIL for a second check)
    const ownerOnly = (request) => {
      const e = request.headers.get('Cf-Access-Authenticated-User-Email');
      if (!e) return 'Not behind Access';
      if (env.OWNER_EMAIL && e.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) return 'Owner only';
      return null;
    };

    if (path === '/admin/new-user' && request.method === 'GET') {
      const bad = ownerOnly(request);
      if (bad) return new Response(bad, { status: 403 });
      const eid = parseInt(url.searchParams.get('id'), 10);
      let c = null;
      if (eid) c = await env.DB.prepare(`SELECT id, name, email, url, location, photo FROM uploaders WHERE id=?`).bind(eid).first();
      return new Response(newUserPage(c), { headers: { 'content-type': 'text/html;charset=utf-8' } });
    }

    if (path === '/admin/api/new-user' && request.method === 'POST') {
      const bad = ownerOnly(request);
      if (bad) return new Response(JSON.stringify({ error: bad }), { status: 403, headers: { ...cors(env), 'content-type': 'application/json' } });
      const form = await request.formData();
      const name = (form.get('name') || '').toString().trim();
      const cemail = (form.get('email') || '').toString().trim().toLowerCase();
      const curl = (form.get('url') || '').toString().trim() || null;
      const location = (form.get('location') || '').toString().trim() || null;
      const editId = parseInt(form.get('id'), 10);
      if (!name || !cemail) return new Response(JSON.stringify({ error: 'Need a name and an Access email' }), { status: 400, headers: { ...cors(env), 'content-type': 'application/json' } });

      // resolve which row we're writing: explicit edit id, else existing email, else new
      let row = null;
      if (editId) row = await env.DB.prepare(`SELECT id, photo FROM uploaders WHERE id=?`).bind(editId).first();
      if (!row) row = await env.DB.prepare(`SELECT id, photo FROM uploaders WHERE lower(email)=?`).bind(cemail).first();
      const id = row ? row.id : (await env.DB.prepare(`SELECT COALESCE(MAX(id),5)+1 AS n FROM uploaders`).first()).n;

      let photo = row ? row.photo : null, note = null;
      const pf = form.get('photo');
      if (pf && pf.size) {
        if (!env.B2_KEY_ID || !env.B2_APP_KEY) {
          note = 'Saved, but the photo was skipped — uploads need B2_KEY_ID/B2_APP_KEY secrets on the Worker.';
        } else {
          const ext = (pf.name.split('.').pop() || 'jpg').toLowerCase();
          const r = await putB2(env, `u${id}.${ext}`, await pf.arrayBuffer(), CT[ext] || 'image/jpeg');
          if (r.ok) photo = `u${id}.${ext}`;
          else note = 'Saved, but the photo upload to B2 failed.';
        }
      }

      if (row) {
        await env.DB.prepare(`UPDATE uploaders SET name=?, email=?, url=?, location=?, photo=? WHERE id=?`)
          .bind(name, cemail, curl, location, photo, id).run();
      } else {
        await env.DB.prepare(`INSERT INTO uploaders (id, name, email, url, location, photo) VALUES (?,?,?,?,?,?)`)
          .bind(id, name, cemail, curl, location, photo).run();
      }
      return Response.json({ id, name, email: cemail, location, photo, note, updated: !!row }, { headers: cors(env) });
    }

    if (path === '/admin' && request.method === 'GET') {
      const bad = ownerOnly(request);
      if (bad) return new Response(bad, { status: 403 });
      const c = await env.DB.prepare(`SELECT COUNT(*) n FROM subscribers WHERE COALESCE(unsubscribed,0)=0 AND COALESCE(bounced,0)=0`).first().catch(() => null);
      return new Response(adminPage(c ? c.n : 0), { headers: { 'content-type': 'text/html;charset=utf-8' } });
    }

    if (path === '/admin/api/curator-delete' && request.method === 'POST') {
      const bad = ownerOnly(request);
      if (bad) return new Response(JSON.stringify({ error: bad }), { status: 403, headers: { ...cors(env), 'content-type': 'application/json' } });
      const f = await request.formData();
      const id = parseInt(f.get('id'), 10);
      if (!id) return new Response(JSON.stringify({ error: 'missing id' }), { status: 400, headers: { ...cors(env), 'content-type': 'application/json' } });
      await env.DB.prepare(`DELETE FROM uploaders WHERE id=?`).bind(id).run();   // tracks keep their uploader_id; the join just shows no credit
      return Response.json({ ok: true }, { headers: cors(env) });
    }

    if (path === '/admin/curators' && request.method === 'GET') {
      const bad = ownerOnly(request);
      if (bad) return new Response(bad, { status: 403 });
      const { results } = await env.DB.prepare(
        `SELECT u.id, u.name, u.email, u.url, u.photo, u.location,
                (SELECT COUNT(*) FROM tunes t WHERE t.uploader_id = u.id) AS tracks
         FROM uploaders u ORDER BY u.id`).all();
      return new Response(curatorsPage(results || []), { headers: { 'content-type': 'text/html;charset=utf-8' } });
    }

    if (path === '/admin/users' && request.method === 'GET') {
      const bad = ownerOnly(request);
      if (bad) return new Response(bad, { status: 403 });
      const { results } = await env.DB.prepare(`SELECT id, email, created_at, unsubscribed, bounced FROM subscribers ORDER BY id DESC`).all();
      return new Response(usersPage(results || []), { headers: { 'content-type': 'text/html;charset=utf-8' } });
    }

    if (path === '/admin/api/subscriber' && request.method === 'POST') {
      const bad = ownerOnly(request);
      if (bad) return new Response(JSON.stringify({ error: bad }), { status: 403, headers: { ...cors(env), 'content-type': 'application/json' } });
      const f = await request.formData();
      const id = parseInt(f.get('id'), 10);
      const action = (f.get('action') || '').toString();
      if (!id) return new Response(JSON.stringify({ error: 'missing id' }), { status: 400, headers: { ...cors(env), 'content-type': 'application/json' } });
      if (action === 'remove') await env.DB.prepare(`DELETE FROM subscribers WHERE id=?`).bind(id).run();
      else if (action === 'bounce') await env.DB.prepare(`UPDATE subscribers SET bounced=1 WHERE id=?`).bind(id).run();
      else if (action === 'restore') await env.DB.prepare(`UPDATE subscribers SET unsubscribed=0, bounced=0 WHERE id=?`).bind(id).run();
      else return new Response(JSON.stringify({ error: 'bad action' }), { status: 400, headers: { ...cors(env), 'content-type': 'application/json' } });
      return Response.json({ ok: true }, { headers: cors(env) });
    }

    if (path === '/admin/stats' && request.method === 'GET') {
      const bad = ownerOnly(request);
      if (bad) return new Response(bad, { status: 403 });
      const now = Date.now();
      const d7 = new Date(now - 7 * 864e5).toISOString();
      const d14 = new Date(now - 14 * 864e5).toISOString();
      const t0 = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').toISOString();
      const one = (sql, ...b) => env.DB.prepare(sql).bind(...b).first().then(r => (r ? Object.values(r)[0] : 0)).catch(() => 0);
      const all = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then(r => r.results || []).catch(() => []);
      const [
        visAll, vis7, visToday, pv7, pvToday, plays7, playsToday, playsAll, shares7,
        emailClicks, emailOpens, subs7, subActive, subUnsub, subBounce,
        topPlays, topShares, sources, countries, daily, recent,
      ] = await Promise.all([
        one(`SELECT COUNT(DISTINCT visitor) FROM events WHERE visitor IS NOT NULL`),
        one(`SELECT COUNT(DISTINCT visitor) FROM events WHERE visitor IS NOT NULL AND ts>=?`, d7),
        one(`SELECT COUNT(DISTINCT visitor) FROM events WHERE visitor IS NOT NULL AND ts>=?`, t0),
        one(`SELECT COUNT(*) FROM events WHERE type='page' AND ts>=?`, d7),
        one(`SELECT COUNT(*) FROM events WHERE type='page' AND ts>=?`, t0),
        one(`SELECT COUNT(*) FROM events WHERE type='play' AND ts>=?`, d7),
        one(`SELECT COUNT(*) FROM events WHERE type='play' AND ts>=?`, t0),
        one(`SELECT COUNT(*) FROM events WHERE type='play'`),
        one(`SELECT COUNT(*) FROM events WHERE type='share' AND ts>=?`, d7),
        one(`SELECT COUNT(*) FROM events WHERE type='email_click'`),
        one(`SELECT COUNT(*) FROM events WHERE type='email_open'`),
        one(`SELECT COUNT(*) FROM events WHERE type='subscribe' AND ts>=?`, d7),
        one(`SELECT COUNT(*) FROM subscribers WHERE COALESCE(unsubscribed,0)=0 AND COALESCE(bounced,0)=0`),
        one(`SELECT COUNT(*) FROM subscribers WHERE unsubscribed=1`),
        one(`SELECT COUNT(*) FROM subscribers WHERE bounced=1`),
        all(`SELECT e.track_id, t.title, t.artist, COUNT(*) n FROM events e LEFT JOIN tunes t ON t.id=e.track_id WHERE e.type='play' GROUP BY e.track_id ORDER BY n DESC LIMIT 10`),
        all(`SELECT e.track_id, t.title, t.artist, COUNT(*) n FROM events e LEFT JOIN tunes t ON t.id=e.track_id WHERE e.type='share' GROUP BY e.track_id ORDER BY n DESC LIMIT 5`),
        all(`SELECT COALESCE(meta,'?') meta, COUNT(*) n FROM events WHERE type='play' GROUP BY meta ORDER BY n DESC`),
        all(`SELECT COALESCE(country,'?') country, COUNT(*) n FROM events WHERE type='page' GROUP BY country ORDER BY n DESC LIMIT 8`),
        all(`SELECT substr(ts,1,10) d, COUNT(*) plays, COUNT(DISTINCT visitor) vis FROM events WHERE type IN ('play','page') AND ts>=? GROUP BY d ORDER BY d`, d14),
        all(`SELECT ts, type, track_id, meta FROM events ORDER BY id DESC LIMIT 15`),
      ]);
      return new Response(statsPage({
        visAll, vis7, visToday, pv7, pvToday, plays7, playsToday, playsAll, shares7,
        emailClicks, emailOpens, subs7, subActive, subUnsub, subBounce,
        topPlays, topShares, sources, countries, daily, recent,
      }), { headers: { 'content-type': 'text/html;charset=utf-8' } });
    }

    if (path === '/admin/preview' && request.method === 'GET') {
      const bad = ownerOnly(request);
      if (bad) return new Response(bad, { status: 403 });
      const sample = { id: 19, title: 'Black Hair', artist: 'Nick Cave & The Bad Seeds', art: 'https://bedtimetunes.com/bedtimetunes.jpg' };
      const { html } = newSongEmail(sample, 'https://audio.bedtimetunes.com/unsubscribe?t=PREVIEW');
      return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
    }

    if (path === '/admin/api/import' && request.method === 'POST') {
      const bad = ownerOnly(request);
      if (bad) return new Response(JSON.stringify({ error: bad }), { status: 403, headers: { ...cors(env), 'content-type': 'application/json' } });
      let raw = '';
      const ct = request.headers.get('content-type') || '';
      if (ct.includes('multipart/form-data')) {
        const f = await request.formData();
        const file = f.get('file');
        raw = (file && file.size) ? await file.text() : (f.get('csv') || '').toString();
      } else {
        const b = await request.json().catch(() => ({}));
        raw = (b.csv || '').toString();
      }
      const emails = [...new Set((raw.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi) || []).map(e => e.toLowerCase()))];
      const now = new Date().toISOString();
      const stmt = env.DB.prepare(`INSERT INTO subscribers (email, created_at, token, unsubscribed) VALUES (?,?,?,0) ON CONFLICT(email) DO NOTHING`);
      let added = 0;
      for (const e of emails) {
        const r = await stmt.bind(e, now, newToken()).run();
        if (r.meta && r.meta.changes) added += r.meta.changes;
      }
      return Response.json({ parsed: emails.length, added, skipped: emails.length - added }, { headers: cors(env) });
    }

    if (path === '/admin/api/broadcast' && request.method === 'POST') {
      const bad = ownerOnly(request);
      if (bad) return new Response(JSON.stringify({ error: bad }), { status: 403, headers: { ...cors(env), 'content-type': 'application/json' } });
      const f = await request.formData();
      const subject = (f.get('subject') || '').toString().trim();
      const body = (f.get('body') || '').toString().trim();
      if (!subject || !body) return new Response(JSON.stringify({ error: 'Subject and message required' }), { status: 400, headers: { ...cors(env), 'content-type': 'application/json' } });
      const r = await emailList(env, subject, (s, unsub) => broadcastEmail(body, unsub));
      return Response.json(r, { headers: cors(env) });
    }

    if (path === '/api/tracks' && request.method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT t.id, t.title, t.artist, t.genre, t.description, t.historical, t.uploader_id,
                t.mp3_key, t.youtube_id, t.spotify_id, t.art_key, t.art_url, t.duration_ms,
                u.name AS uploader_name, u.url AS uploader_url, u.photo AS uploader_photo, u.location AS uploader_location
           FROM tunes t LEFT JOIN uploaders u ON u.id = t.uploader_id
          ORDER BY t.id DESC`
      ).all();
      return Response.json(results, { headers: { ...cors(env), 'Cache-Control': 'public, max-age=30' } });
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
      if (known) uploader = known.id;                       // curator added via /admin/new-user
      else { let map = {}; try { map = JSON.parse(env.CONTRIBUTORS || '{}'); } catch {} uploader = map[email] ?? parseInt(env.DEFAULT_UPLOADER || '2', 10); }
      const nextId = (await env.DB.prepare(`SELECT COALESCE(MAX(id),146)+1 AS n FROM tunes`).first()).n;

      const ctype = request.headers.get('content-type') || '';
      let f = { title: '', artist: '', genre: '', description: '', historical: '' };
      let src = {}, mp3_key = null, art_key = null, notify = false;

      if (ctype.includes('multipart/form-data')) {
        const form = await request.formData();
        for (const k of Object.keys(f)) f[k] = form.get(k) || '';
        notify = !!form.get('notify');
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
        notify = !!body.notify;
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
      if (notify) {
        let mailArt = art_key ? `https://audio.bedtimetunes.com/${art_key}` : (f.art_url || null);
        if (!mailArt && src.youtube_id) mailArt = `https://i.ytimg.com/vi/${src.youtube_id}/hqdefault.jpg`;
        ctx.waitUntil(emailList(env, `New tune: ${f.title || 'Untitled'} — ${f.artist || ''}`.trim(),
          (s, unsub) => newSongEmail({ id: nextId, title: f.title || '(untitled)', artist: f.artist || '', art: mailArt }, unsub)));
      }
      return Response.json({ id: nextId, by: email, uploader, mp3_key, art_key, notified: notify, ...src }, { headers: cors(env) });
    }

    // ── analytics: event beacon (site), click redirect + open pixel (email) ──
    if (path === '/api/event' && request.method === 'POST') {
      if (isBot(request.headers.get('User-Agent'))) return new Response(null, { status: 204, headers: cors(env) });
      let b = {};
      try { b = JSON.parse(await request.text()); } catch (e) {}
      const allowed = ['play', 'switch', 'share', 'page', 'subscribe', 'email_click', 'email_open'];
      const type = (b.type || '').toString();
      if (!allowed.includes(type)) return new Response(null, { status: 204, headers: cors(env) });
      const tid = b.track_id ? parseInt(b.track_id, 10) : null;
      const meta = b.meta ? String(b.meta).slice(0, 200) : null;
      const vis = await visitorId(request, env);
      try {
        await env.DB.prepare(`INSERT INTO events (ts,type,track_id,meta,country,visitor) VALUES (?,?,?,?,?,?)`)
          .bind(new Date().toISOString(), type, Number.isNaN(tid) ? null : tid, meta, (request.cf && request.cf.country) || null, vis).run();
      } catch (e) {}
      return new Response(null, { status: 204, headers: cors(env) });
    }

    if (path === '/r' && request.method === 'GET') {
      const u = url.searchParams.get('u') || '';
      const e = (url.searchParams.get('e') || 'email_click').slice(0, 20);
      const t = url.searchParams.get('t');
      let dest = 'https://bedtimetunes.com';
      try { const d = new URL(u); if (d.hostname === 'bedtimetunes.com' || d.hostname === 'audio.bedtimetunes.com') dest = d.toString(); } catch (_) {}
      try {
        await env.DB.prepare(`INSERT INTO events (ts,type,track_id,meta,country,visitor) VALUES (?,?,?,?,?,?)`)
          .bind(new Date().toISOString(), e, t ? parseInt(t, 10) : null, 'email', (request.cf && request.cf.country) || null, await visitorId(request, env)).run();
      } catch (_) {}
      return Response.redirect(dest, 302);
    }

    if (path === '/o.gif' && request.method === 'GET') {
      const t = url.searchParams.get('t'), c = url.searchParams.get('c');
      try {
        await env.DB.prepare(`INSERT INTO events (ts,type,track_id,meta) VALUES (?,?,?,?)`)
          .bind(new Date().toISOString(), 'email_open', t ? parseInt(t, 10) : null, (c || 'email').slice(0, 60)).run();
      } catch (_) {}
      const gif = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), x => x.charCodeAt(0));
      return new Response(gif, { headers: { 'content-type': 'image/gif', 'Cache-Control': 'no-store, max-age=0', ...cors(env) } });
    }

    // ── mailing list: public subscribe / unsubscribe ──
    if (path === '/api/subscribe' && request.method === 'POST') {
      let email = '';
      const ct = request.headers.get('content-type') || '';
      if (ct.includes('application/json')) { const b = await request.json().catch(() => ({})); email = (b.email || '').toString(); }
      else { const f = await request.formData(); email = (f.get('email') || '').toString(); }
      email = email.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
        return Response.json({ error: 'Please enter a valid email' }, { status: 400, headers: cors(env) });
      await env.DB.prepare(`INSERT INTO subscribers (email, created_at, token, unsubscribed) VALUES (?,?,?,0)
                            ON CONFLICT(email) DO UPDATE SET unsubscribed=0`)
        .bind(email, new Date().toISOString(), newToken()).run();
      try { await env.DB.prepare(`INSERT INTO events (ts,type,meta,country,visitor) VALUES (?,?,?,?,?)`).bind(new Date().toISOString(), 'subscribe', 'site', (request.cf && request.cf.country) || null, await visitorId(request, env)).run(); } catch (e) {}
      return Response.json({ ok: true }, { headers: cors(env) });
    }

    if (path === '/unsubscribe' && request.method === 'GET') {
      const t = url.searchParams.get('t');
      if (t) {
        await env.DB.prepare(`UPDATE subscribers SET unsubscribed=1 WHERE token=?`).bind(t).run();
        try { await env.DB.prepare(`INSERT INTO events (ts,type,meta) VALUES (?,?,?)`).bind(new Date().toISOString(), 'unsubscribe', 'email').run(); } catch (e) {}
      }
      return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title>
<style>body{background:#160a1a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:1rem}a{color:#e8739a}</style></head>
<body><div><h2 style="font-weight:400">You've been unsubscribed.</h2><p style="color:rgba(255,255,255,.6)">You won't get any more emails from Bedtime Tunes.<br><a href="https://bedtimetunes.com">← back to the player</a></p></div></body></html>`,
        { headers: { 'content-type': 'text/html;charset=utf-8' } });
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
      const ogimg = `https://audio.bedtimetunes.com/og.png/${t.id}`;
      const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${title} · Bedtime Tunes</title>
<meta property="og:type" content="music.song">
<meta property="og:site_name" content="Bedtime Tunes">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${ogimg}">
<meta property="og:image:type" content="image/png">
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
      const svg = await buildOgSvg(env, id);
      return new Response(svg, { headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400', ...cors(env) } });
    }

    if (path === '/og.png' || path.startsWith('/og.png/')) {
      const cache = caches.default;
      const cacheKey = new Request(new URL(url.pathname, url.origin).toString());
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
      const id = (path.match(/\/og\.png\/(\d+)/) || [])[1];
      const svg = await buildOgSvg(env, id);
      try {
        const png = await svgToPng(svg);
        const resp = new Response(png, { headers: { 'content-type': 'image/png', 'Cache-Control': 'public, max-age=86400', ...cors(env) } });
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        return resp;
      } catch (e) {
        return new Response(svg, { headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-OG-Fallback': 'svg', ...cors(env) } });
      }
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