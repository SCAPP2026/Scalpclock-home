const CACHE = 'sc-v40';
const STATIC = [
  '/',
  '/index.html',
  '/offline.html',
  '/login.html',
  '/dashboard.html',
  '/signals.html',
  '/journal.html',
  '/news.html',
  '/settings.html',
  '/exitassistant.html',
  '/scalpchart.html',
  '/pricing.html',
  '/faq.html',
  '/learn.html',
  '/about.html',
  '/trading-resources.html',
  '/learn-options-trading.html',
  '/referrals.html',
  '/founders.html',
  '/leaderboard.html',
  '/admin-referrals.html',
  '/js/sc-learn-progress.js',
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

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('/dashboard') && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/dashboard');
    })
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

  // Always network-first for this site's own API routes, and for every
  // cross-origin request (Supabase REST/auth calls above all — trades,
  // watchlist, session, etc.). Without the origin check, a Supabase GET
  // (different origin, so it never matches /api/) fell through to the
  // cache-first branch below and got permanently cached on first load —
  // e.g. closing a trade updated the DB fine, but the Trade Journal kept
  // showing the pre-close data from cache until a hard refresh bypassed
  // the service worker entirely.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    return;
  }

  // Network-first for HTML pages/navigations. Twice now, a content update
  // to a precached page (learn.html, signals.html, pricing.html, etc.) sat
  // invisible for every returning visitor until someone remembered to bump
  // CACHE by hand — cache-first on HTML means "stale until a human
  // remembers" is the default failure mode, not an edge case. HTML is
  // cheap to refetch and changes far more often than static assets, so it
  // gets its own branch: try the network, update the cache opportunistically
  // for offline use, and only fall back to whatever's cached (or the
  // offline page) if the network genuinely fails.
  const isHTML = e.request.mode === 'navigate'
    || e.request.destination === 'document'
    || (e.request.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        // Redirected responses (e.g. /blog -> /blog/) can't be replayed by
        // the service worker as-is — Chrome throws "Response served by
        // service worker has redirections". Rebuild a fresh, non-redirected
        // Response with the same body/status so the browser can render it.
        return res.redirected
          ? new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers })
          : res;
      }).catch(() => caches.match(e.request).then(cached => cached || caches.match('/offline.html')))
    );
    return;
  }

  // Cache-first for everything else (JS, CSS, images, manifest) — static
  // assets that are far less staleness-sensitive and benefit from instant
  // cache hits.
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res.redirected
          ? new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers })
          : res;
      }).catch(() => {
        if (e.request.mode === 'navigate') return caches.match('/offline.html');
      });
    })
  );
});
