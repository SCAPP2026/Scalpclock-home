const CACHE = 'sc-v16';
const STATIC = [
  '/',
  '/index.html',
  '/offline.html',
  '/login.html',
  '/dashboard.html',
  '/exitassistant.html',
  '/scalpchart.html',
  '/pricing.html',
  '/faq.html',
  '/learn.html',
  '/about.html',
  '/blog/',
  '/blog/posts.json',
  '/js/blog-chart.js',
  '/css/theme-light.css',
  '/hero.png',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/favicon.ico',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always network-first for API calls
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    return;
  }

  // Cache-first for static assets
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        // Navigations can't be satisfied by a redirected Response (e.g. /blog
        // -> /blog/) — Chrome throws "Response served by service worker has
        // redirections". Rebuild a fresh, non-redirected Response with the
        // same body/status so the browser can render it.
        return res.redirected
          ? new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers })
          : res;
      }).catch(() => {
        // Full-page navigations fall back to a dedicated offline page;
        // other assets (images, scripts) just fail through.
        if (e.request.mode === 'navigate') return caches.match('/offline.html');
      });
    })
  );
});
