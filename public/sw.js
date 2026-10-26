/* 오프라인용 캐시.
   인터넷이 되면 항상 서버에서 먼저 받는다(바뀌지 않았으면 304라 가볍다). 3초 안에 못 받거나 오프라인이면 저장본을 쓴다.
   그래서 새 해설·새 기능이 다음 실행을 기다리지 않고 바로 보인다. /api/는 건드리지 않는다. */
const V = 'gb-v11';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
  'data/kor.json', 'data/eng.json', 'data/law.json', 'data/adm.json', 'data/ox_law.json', 'data/ox_adm.json', 'data/concept_law.json', 'data/concept_adm.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return;
  const isFont = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname) || (url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('/pretendard'));
  if (url.origin !== location.origin && !isFont) return;
  e.respondWith(caches.open(V).then(async c => {
    const net = fetch(req, { cache: 'no-cache' }).then(r => { if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r; });
    const timeout = new Promise(res => setTimeout(res, 3000, null));
    try {
      const r = await Promise.race([net, timeout]);
      if (r) return r;
    } catch (err) { /* 오프라인 */ }
    const hit = await c.match(req, { ignoreSearch: true });
    return hit || net;
  }));
});
