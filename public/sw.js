/* 오프라인용 캐시. 캐시에서 먼저 보여주고 뒤에서 새 버전을 받아 둔다(다음에 열 때 반영).
   /api/는 건드리지 않는다. 앱을 고치면 V를 올린다. */
const V = 'gb-v5';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
  'data/kor.json', 'data/eng.json', 'data/law.json', 'data/adm.json', 'data/ox_law.json', 'data/ox_adm.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return;
  const isFont = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (url.origin !== location.origin && !isFont) return;
  e.respondWith(caches.open(V).then(async c => {
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
