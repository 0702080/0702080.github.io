/* 네트워크 우선 서비스워커
   - 온라인이면 항상 최신 파일을 받아옴 (캐시 때문에 옛 버전 보이는 문제 방지)
   - 오프라인이면 마지막으로 받은 파일로 동작                                */
const CACHE = 'nametag-cache';

self.addEventListener('install', e => { self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));

    /* 버전 확인용 요청(?_c=…)은 매번 주소가 달라서 캐시에 항목이 계속 쌓인다.
       예전 버전이 남겨놓은 찌꺼기를 여기서 한 번 걷어낸다. */
    const c = await caches.open(CACHE);
    const olds = (await c.keys()).filter(r => new URL(r.url).searchParams.has('_c'));
    await Promise.all(olds.map(r => c.delete(r)));

    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  // 버전 확인용 임시 요청은 캐시에 남기지 않는다 (매번 주소가 달라 무한히 쌓임)
  const skipCache = new URL(req.url).searchParams.has('_c');

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req, { cache: 'no-store' });   // 항상 서버에서
      if (!skipCache) {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      const hit = await caches.match(req);                     // 오프라인 대비
      if (hit) return hit;
      throw err;
    }
  })());
});
