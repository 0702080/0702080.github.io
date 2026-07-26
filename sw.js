/* 네트워크 우선 서비스워커
   - 온라인이면 항상 최신 파일을 받아옴 (캐시 때문에 옛 버전 보이는 문제 방지)
   - 오프라인이면 마지막으로 받은 파일로 동작                                */
const CACHE = 'nametag-cache';

self.addEventListener('install', e => { self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req, { cache: 'no-store' });   // 항상 서버에서
      const cache = await caches.open(CACHE);
      cache.put(req, fresh.clone());
      return fresh;
    } catch (err) {
      const hit = await caches.match(req);                     // 오프라인 대비
      if (hit) return hit;
      throw err;
    }
  })());
});
