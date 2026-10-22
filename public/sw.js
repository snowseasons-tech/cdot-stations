// Service worker: makes the page installable and gives it a small safety net when the connection drops.
// The app needs a connection (no offline mode), so everything is network-first and the cache is only a fallback.
//
// Rules that matter:
//  - The API is never touched: data always comes live from the server.
//  - Only plain same-origin 200 responses are cached. Redirects (such as the Cloudflare Access sign-in) and anything
//    cross-origin are passed through untouched and never stored, so a sign-in page can't end up cached as "the app".
const CACHE = 'shell-v1';
const SHELL = ['/', '/styles.css', '/app.js', '/install.js', '/manifest.webmanifest', '/icons/icon-192.png'];

const cacheable = (res) => res.ok && res.type === 'basic' && !res.redirected;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(SHELL.map((url) => fetch(url).then((res) => (cacheable(res) ? cache.put(url, res) : undefined)).catch(() => {}))),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return; // not ours

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (cacheable(res)) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (error) {
      const cached = await caches.match(req) ?? (req.mode === 'navigate' ? await caches.match('/') : undefined);
      if (cached) return cached;
      throw error;
    }
  })());
});
