// Service worker: makes the page installable and gives it a small safety net when the connection drops.
// The app needs a connection (no offline mode), so everything is network-first and the cache is only a fallback.
//
// Rules that matter:
//  - The API is never touched: data always comes live from the server.
//  - Only plain same-origin 200 responses are cached. Redirects (such as the Cloudflare Access sign-in) and anything
//    cross-origin are passed through untouched and never stored, so a sign-in page can't end up cached as "the app".
const CACHE = 'shell-v1';
const SHELL = ['/', '/styles.css', '/app.js', '/follow.js', '/move.js', '/install.js', '/manifest.webmanifest', '/icons/icon-192.png'];

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

// ---- push notifications --------------------------------------------------------------------------------
// The server sends { title, body, tag, url } when a station's status or note changes. Every push must show a
// notification (phones require it), so a malformed one still produces a generic notice instead of nothing.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const tag = typeof data.tag === 'string' ? data.tag : undefined;
  event.waitUntil(self.registration.showNotification(typeof data.title === 'string' && data.title ? data.title : 'Station update', {
    body: typeof data.body === 'string' ? data.body : '',
    tag,
    renotify: Boolean(tag), // a newer message about the same station should alert again, not replace silently
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: typeof data.url === 'string' ? data.url : '/' },
  }));
});

// Tapping a notification opens (or focuses) the app on that station. Only addresses on this site are followed.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let target = new URL('/', self.location.origin).href;
  try {
    const wanted = new URL(event.notification.data?.url ?? '/', self.location.origin);
    if (wanted.origin === self.location.origin) target = wanted.href;
  } catch { /* keep the home page */ }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (open) {
      if ('navigate' in open) await open.navigate(target).catch(() => {});
      return open.focus();
    }
    return self.clients.openWindow(target);
  })());
});
