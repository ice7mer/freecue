// Zero-dependency server: serves /public and proxies Pexels/Pixabay using YOUR keys (env vars).
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public');
const KEY = { pexels: process.env.PEXELS_API_KEY, pixabay: process.env.PIXABAY_API_KEY };
const enc = encodeURIComponent;
const ICON_RE = /\b(icons?|vectors?|svg)\b/i;

function resolvePixabayImageType(q, type) {
  if (type && type !== 'all') return type;
  return ICON_RE.test(q) ? 'vector' : 'all';
}

const ROUTES = {
  'pexels/videos': { p: 'pexels', ttl: 36e5, url: q => 'https://api.pexels.com/videos/search?per_page=15&query=' + enc(q) },
  'pexels/photos': { p: 'pexels', ttl: 36e5, url: q => 'https://api.pexels.com/v1/search?per_page=18&query=' + enc(q) },
  'pixabay/videos': { p: 'pixabay', ttl: 864e5, url: (q, ai) => 'https://pixabay.com/api/videos/?per_page=20&key=' + enc(KEY.pixabay) + '&q=' + enc(ai ? q + ' ai generated' : q) },
  'pixabay/images': {
    p: 'pixabay',
    ttl: 864e5,
    url: (q, ai, type) => {
      const effectiveType = resolvePixabayImageType(q, type);
      return 'https://pixabay.com/api/?per_page=20&image_type=' + enc(effectiveType) + '&key=' + enc(KEY.pixabay) + '&q=' + enc(ai ? q + ' ai generated' : q);
    }
  }
};
const MIME = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const cache = new Map(), hits = new Map();
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (n > v.reset) hits.delete(k); }, 6e4).unref();

function limited(ip) {
  const n = Date.now(); let h = hits.get(ip);
  if (!h || n > h.reset) { h = { n: 0, reset: n + 6e4 }; hits.set(ip, h); }
  return ++h.n > 40; // 40 API calls / minute / IP
}
function json(res, code, obj, cacheable) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheable ? 'public, max-age=300' : 'no-store' });
  res.end(JSON.stringify(obj));
}
async function api(req, res, u) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method' });
  const r = ROUTES[u.pathname.slice(5)];
  if (!r) return json(res, 404, { error: 'not found' });
  if (!KEY[r.p]) return json(res, 503, { error: 'not configured' });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (limited(ip)) return json(res, 429, { error: 'slow down' });
  const q = (u.searchParams.get('q') || '').trim().slice(0, 100), ai = u.searchParams.get('ai') === '1';
  const tp = u.searchParams.get('type'), type = ['all', 'photo', 'illustration', 'vector'].includes(tp) ? tp : 'all';
  if (!q) return json(res, 400, { error: 'q required' });
  const effectiveType = r.p === 'pixabay' && u.pathname.endsWith('/images') ? resolvePixabayImageType(q, type) : type;
  const ck = u.pathname + '|' + q.toLowerCase() + '|' + ai + '|' + effectiveType, c = cache.get(ck);
  if (c && Date.now() < c.exp) return json(res, 200, c.data, true);
  const headers = r.p === 'pexels' ? { Authorization: KEY.pexels } : {};
  const up = await fetch(r.url(q, ai, effectiveType), { headers, signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!up || !up.ok) return json(res, 502, { error: 'upstream' });
  const data = await up.json();
  if (cache.size >= 500) cache.delete(cache.keys().next().value);
  cache.set(ck, { exp: Date.now() + r.ttl, data });
  json(res, 200, data, true);
}
function serveStatic(req, res, u) {
  let p = decodeURIComponent(u.pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(PUB, path.normalize(p));
  if (f !== PUB && !f.startsWith(PUB + path.sep)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(f);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
    res.end(b);
  });
}
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    serveStatic(req, res, u);
  } catch (e) { json(res, 500, { error: 'server error' }); }
}).listen(PORT, '0.0.0.0', () => console.log('listening on ' + PORT));
