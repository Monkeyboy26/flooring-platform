const CACHE_NAME = 'roma-v42';
const IMAGE_CACHE = 'roma-images-v1';
const IMAGE_CACHE_LIMIT = 500;
const SHELL_ASSETS = [
  '/storefront.html',
  '/storefront.css?v=45',
  '/storefront-app.js?v=89',
  '/favicon.svg',
  '/manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== IMAGE_CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Trim image cache to limit, evicting oldest entries
async function trimCache(cacheName, limit) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > limit) {
    await Promise.all(keys.slice(0, keys.length - limit).map(k => cache.delete(k)));
  }
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API — network only
  if (url.pathname.startsWith('/api/')) return;

  // Uploads — cache first
  if (url.pathname.startsWith('/uploads/')) {
    e.respondWith(
      caches.match(e.request).then(cached =>
        cached || fetch(e.request).then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          return res;
        }).catch(() => new Response('', { status: 404 }))
      )
    );
    return;
  }

  // External images (product CDNs) — stale-while-revalidate with size-limited cache
  if (url.origin !== location.origin && /\.(jpg|jpeg|png|webp|gif|svg)(\?|$)/i.test(url.pathname)) {
    e.respondWith(
      caches.open(IMAGE_CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          const fetchPromise = fetch(e.request).then(res => {
            if (res.ok || res.type === 'opaque') {
              cache.put(e.request, res.clone());
              trimCache(IMAGE_CACHE, IMAGE_CACHE_LIMIT);
            }
            return res;
          }).catch(() => cached || new Response('', { status: 503 }));
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // CDN (React, fonts, Stripe) — stale while revalidate
  if (url.origin !== location.origin) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const fetchPromise = fetch(e.request).then(res => {
          if (res.ok || res.type === 'opaque') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return res;
        }).catch(() => cached || new Response('', { status: 503 }));
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Navigation — network first, fall back to cached shell
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/storefront.html'))
    );
    return;
  }

  // Other static — stale while revalidate
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => cached || new Response('', { status: 503 }));
      return cached || fetchPromise;
    })
  );
});
