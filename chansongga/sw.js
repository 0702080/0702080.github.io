/* 내 찬송가 — 서비스워커 (오프라인 지원) */
const VERSION = 'hymn-v10';
const SHELL = [
  './', './index.html', './app.css', './app.js',
  './manifest.webmanifest', './data/hymns.json', './data/hymns.sample.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
  'https://cdn.jsdelivr.net/npm/opensheetmusicdisplay@1.9.0/build/opensheetmusicdisplay.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    // 하나가 실패해도 나머지는 캐시되도록 개별 처리한다.
    await Promise.allSettled(SHELL.map(u => c.add(new Request(u, { cache: 'reload' }))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  // 앱 코드와 데이터는 네트워크 우선 — 고치면 바로 반영되어야 한다.
  // (캐시 우선으로 두면 app.js 를 고쳐도 옛 버전이 계속 나온다.)
  const isFresh = sameOrigin && (
    req.mode === 'navigate' ||
    /\.(html|js|css|webmanifest|json)$/i.test(url.pathname)
  );

  if (isFresh) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) {
          const c = await caches.open(VERSION);
          c.put(req, res.clone());
        }
        return res;
      } catch (err) {
        const hit = await caches.match(req);
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      }
    })());
    return;
  }

  // 악보 이미지처럼 바뀌지 않는 자료는 캐시 우선 — 오프라인에서 즉시 뜨게.
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: false });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && (url.origin === location.origin || url.host.includes('jsdelivr'))) {
        const c = await caches.open(VERSION);
        c.put(req, res.clone());
      }
      return res;
    } catch (err) {
      if (req.mode === 'navigate') return caches.match('./index.html');
      return Response.error();
    }
  })());
});

self.addEventListener('message', async e => {
  if (!e.data || e.data.type !== 'CACHE_URLS') return;
  const c = await caches.open(VERSION);
  const results = await Promise.allSettled(
    e.data.urls.map(u => c.add(new Request(u, { cache: 'reload' })))
  );
  const ok = results.filter(r => r.status === 'fulfilled').length;
  const clients = await self.clients.matchAll();
  clients.forEach(cl => cl.postMessage({ type: 'CACHE_DONE', ok, total: e.data.urls.length }));
});
