import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createApp } from '../server.js';

const read = (p) => readFile(new URL(`../public/${p}`, import.meta.url));

async function start(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-'));
  const server = await createApp({ statusFile: join(dir, 'status.json') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('manifest has what installability requires, and every icon exists at its declared size', async () => {
  const m = JSON.parse(await read('manifest.webmanifest'));
  for (const key of ['name', 'short_name', 'start_url', 'scope', 'display', 'theme_color', 'background_color']) assert.ok(m[key], key);
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some((i) => i.sizes === '192x192' && i.purpose === 'any'));
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any'));
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  for (const icon of [...m.icons, { src: '/icons/apple-touch-icon.png', sizes: '180x180' }]) {
    const png = await read(icon.src.slice(1));
    assert.equal(png.subarray(1, 4).toString(), 'PNG', icon.src);
    const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)]; // IHDR width and height
    assert.equal(`${w}x${h}`, icon.sizes, icon.src);
    assert.notEqual(png[25], 6, `${icon.src} must not have an alpha channel (iOS fills it with black)`); // colour type 6 = RGBA
  }
});

test('the page links the manifest, icons and install script', async () => {
  const html = (await read('index.html')).toString();
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials">/); // cookies are needed behind Cloudflare Access
  assert.match(html, /rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/);
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /<script src="install\.js"><\/script>/);
});

test('server serves the manifest, icons and worker with the right types, and allows them in the CSP', async (t) => {
  const base = await start(t);
  const manifest = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(manifest.headers.get('content-type'), 'application/manifest+json');
  assert.equal((await fetch(`${base}/icons/icon-192.png`)).headers.get('content-type'), 'image/png');
  const sw = await fetch(`${base}/sw.js`);
  assert.equal(sw.status, 200);
  assert.equal(sw.headers.get('cache-control'), 'no-cache');
  const csp = manifest.headers.get('content-security-policy');
  assert.match(csp, /manifest-src 'self'/);
  assert.match(csp, /worker-src 'self'/);
  assert.match(csp, /default-src 'none'/); // still deny-by-default
});

// ---- the service worker, run in a sandbox with a fake cache and fake network
function worker({ network }) {
  const handlers = {};
  const store = new Map();
  const cache = {
    put: async (req, res) => { store.set(typeof req === 'string' ? new URL(req, 'https://app.test').href : req.url, res); },
  };
  const caches = {
    open: async () => cache,
    match: async (req) => store.get(typeof req === 'string' ? new URL(req, 'https://app.test').href : req.url),
    keys: async () => [], delete: async () => true,
  };
  const self = { location: { origin: 'https://app.test' }, addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting: async () => {}, clients: { claim: async () => {} } };
  vm.runInNewContext(readFileSyncText(), { self, caches, fetch: network, URL, Promise });
  const fetchEvent = (url, { method = 'GET', mode = 'cors' } = {}) => {
    let responded;
    const event = { request: { url, method, mode }, respondWith: (p) => { responded = p; } };
    handlers.fetch(event);
    return responded; // undefined when the worker lets the browser handle it
  };
  return { fetchEvent, store };
}
import { readFileSync } from 'node:fs';
const readFileSyncText = () => readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const res = (init = {}) => ({ ok: true, type: 'basic', redirected: false, clone() { return { ...this }; }, ...init });

test('service worker never touches the API, writes, or other origins', () => {
  const { fetchEvent } = worker({ network: async () => res() });
  assert.equal(fetchEvent('https://app.test/api/stations'), undefined);
  assert.equal(fetchEvent('https://app.test/api/stations/limon/status', { method: 'PUT' }), undefined);
  assert.equal(fetchEvent('https://app.test/app.js', { method: 'POST' }), undefined);
  assert.equal(fetchEvent('https://tile.openstreetmap.org/7/1/2.png'), undefined);
  assert.equal(fetchEvent('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'), undefined);
});

test('service worker serves live content first and caches only plain successful responses', async () => {
  const live = res();
  const { fetchEvent, store } = worker({ network: async () => live });
  assert.equal(await fetchEvent('https://app.test/app.js'), live);
  await new Promise((r) => setImmediate(r));
  assert.ok(store.has('https://app.test/app.js'));
});

test('service worker never caches a redirect (such as the Access sign-in) or an error', async () => {
  for (const bad of [res({ type: 'opaqueredirect', ok: false }), res({ redirected: true }), res({ ok: false }), res({ type: 'cors' })]) {
    const { fetchEvent, store } = worker({ network: async () => bad });
    assert.equal(await fetchEvent('https://app.test/', { mode: 'navigate' }), bad); // passed through untouched
    await new Promise((r) => setImmediate(r));
    assert.equal(store.size, 0, JSON.stringify({ type: bad.type, ok: bad.ok, redirected: bad.redirected }));
  }
});

test('when the network fails, service worker falls back to the cache, and the shell for page loads', async () => {
  let online = true;
  const cachedApp = res(); const cachedHome = res();
  const { fetchEvent, store } = worker({ network: async () => { if (!online) throw new TypeError('Failed to fetch'); return res(); } });
  store.set('https://app.test/app.js', cachedApp);
  store.set('https://app.test/', cachedHome);
  online = false;
  assert.equal(await fetchEvent('https://app.test/app.js'), cachedApp);
  assert.equal(await fetchEvent('https://app.test/anything', { mode: 'navigate' }), cachedHome);
  await assert.rejects(fetchEvent('https://app.test/never-cached.js'), TypeError); // nothing to fall back to
});

// ---- install helper
test('detectPlatform recognises iPhone, iPad (even disguised as a Mac), Android, and the iOS version', async () => {
  const sandbox = { window: {} };
  vm.runInNewContext((await read('install.js')).toString(), sandbox);
  const { detectPlatform, iosSupportsPush } = sandbox.window.installHelpers;

  const iphone = detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Version/17.2 Mobile/15E148 Safari/604.1');
  assert.equal(JSON.stringify([iphone.os, iphone.iosVersion]), JSON.stringify(['ios', [17, 2]])); // by value: the sandbox's arrays are from another realm
  const old = detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148');
  assert.equal(iosSupportsPush(old.iosVersion), false);
  assert.equal(iosSupportsPush([16, 3]), false);
  assert.equal(iosSupportsPush([16, 4]), true);
  assert.equal(iosSupportsPush([17, 0]), true);
  assert.equal(iosSupportsPush(null), true);

  const ipad = detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', { platform: 'MacIntel', maxTouchPoints: 5 });
  assert.equal(ipad.os, 'ios');
  const mac = detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', { platform: 'MacIntel', maxTouchPoints: 0 });
  assert.equal(mac.os, 'other');
  assert.equal(detectPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36').os, 'android');
  assert.equal(detectPlatform('Mozilla/5.0 (X11; Linux x86_64) Chrome/120', { standalone: true }).standalone, true);
});

// ---- push handling in the service worker
function pushWorker({ windows = [] } = {}) {
  const handlers = {}; const shown = []; const opened = []; const waits = [];
  const self = {
    location: { origin: 'https://app.test' },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    registration: { showNotification: async (title, options) => { shown.push({ title, ...options }); } },
    clients: { matchAll: async () => windows, openWindow: async (url) => { opened.push(url); }, claim: async () => {} },
  };
  vm.runInNewContext(readFileSyncText(), { self, caches: {}, fetch: async () => {}, URL, Promise });
  const event = (extra) => ({ waitUntil: (p) => waits.push(p), ...extra });
  return {
    shown, opened,
    async push(data) { handlers.push(event({ data })); await Promise.all(waits.splice(0)); },
    async click(url) { let closed = false; handlers.notificationclick(event({ notification: { close: () => { closed = true; }, data: url === undefined ? undefined : { url } } })); await Promise.all(waits.splice(0)); return closed; },
  };
}

test('a push shows a notification with the server\'s title, text and tag, and opens that station when tapped', async () => {
  const w = pushWorker();
  await w.push({ json: () => ({ title: 'Limon: Open', body: 'No wait', tag: 'limon', url: '/?station=limon' }) });
  assert.equal(w.shown.length, 1);
  assert.deepEqual([w.shown[0].title, w.shown[0].body, w.shown[0].tag, w.shown[0].renotify, w.shown[0].data.url], ['Limon: Open', 'No wait', 'limon', true, '/?station=limon']);
  assert.match(w.shown[0].icon, /icon-192/);
});

test('a malformed or empty push still shows a notification (phones require one)', async () => {
  const w = pushWorker();
  await w.push({ json: () => { throw new SyntaxError('bad'); }, text: () => 'plain text' });
  await w.push(undefined);
  await w.push({ json: () => ({ title: 42, body: { x: 1 } }) });
  assert.equal(w.shown.length, 3);
  assert.deepEqual(w.shown.map((n) => n.title), ['Station update', 'Station update', 'Station update']);
  assert.equal(w.shown[0].body, 'plain text');
  assert.equal(w.shown[2].body, '');
  assert.equal(w.shown[2].renotify, false);
});

test('tapping a notification focuses an open window or opens one, and never leaves this site', async () => {
  const navigated = []; let focused = 0;
  const open = { url: 'https://app.test/', navigate: async (u) => { navigated.push(u); }, focus: async () => { focused++; } };
  const withWindow = pushWorker({ windows: [open] });
  assert.equal(await withWindow.click('/?station=limon'), true); // the notification is closed
  assert.deepEqual(navigated, ['https://app.test/?station=limon']);
  assert.equal(focused, 1);
  assert.deepEqual(withWindow.opened, []);

  const closedApp = pushWorker();
  await closedApp.click('/?station=cortez');
  assert.deepEqual(closedApp.opened, ['https://app.test/?station=cortez']);

  const hostile = pushWorker();
  await hostile.click('https://evil.example/phish');
  await hostile.click('//evil.example/phish');
  await hostile.click(undefined);
  assert.deepEqual(hostile.opened, ['https://app.test/', 'https://app.test/', 'https://app.test/']);
});

// ---- follow helpers
test('follow helpers: toggling stations, "all", and decoding the server key', async () => {
  const sandbox = { window: {}, atob: (s) => Buffer.from(s, 'base64').toString('binary'), Uint8Array };
  vm.runInNewContext((await read('follow.js')).toString(), sandbox);
  const { nextFollowing, toggleAll, isFollowing, urlBase64ToUint8Array, sameBytes } = sandbox.window.followHelpers;
  const all = ['cortez', 'dumont', 'limon'];
  const L = (a) => JSON.stringify(a); // arrays from the sandbox compare by value

  assert.equal(L(nextFollowing([], 'limon', all)), L(['limon']));
  assert.equal(L(nextFollowing(['limon'], 'cortez', all)), L(['limon', 'cortez']));
  assert.equal(L(nextFollowing(['limon', 'cortez'], 'limon', all)), L(['cortez']));
  assert.equal(L(nextFollowing(['limon'], 'limon', all)), L([]));                          // last one off = unfollow everything
  assert.equal(L(nextFollowing(['all'], 'limon', all)), L(['cortez', 'dumont']));           // "all" minus the tapped station
  assert.equal(L(toggleAll([])), L(['all']));
  assert.equal(L(toggleAll(['limon'])), L(['all']));
  assert.equal(L(toggleAll(['all'])), L([]));
  assert.equal(isFollowing(['all'], 'limon'), true);
  assert.equal(isFollowing(['cortez'], 'limon'), false);

  // url-safe base64 with and without padding decodes to the same bytes
  const bytes = urlBase64ToUint8Array('SGVsbG8_Pz4-'); // "Hello??>>" with url-safe characters
  assert.equal(Buffer.from(bytes).toString('latin1'), 'Hello??>>');
  assert.equal(sameBytes(urlBase64ToUint8Array('SGk'), urlBase64ToUint8Array('SGk=')), true);
  assert.equal(sameBytes(urlBase64ToUint8Array('SGk'), urlBase64ToUint8Array('SGo')), false);
});

test('the page has the notifications panel and loads the follow script', async () => {
  const html = (await read('index.html')).toString();
  assert.match(html, /id="notify"[^>]*hidden/);
  assert.match(html, /id="notify-all"/);
  assert.match(html, /<script src="follow\.js"><\/script>/);
});

test('install.js loads before follow.js (follow.js uses its platform helpers to explain iPhone requirements)', async () => {
  const html = (await read('index.html')).toString();
  assert.ok(html.indexOf('src="install.js"') !== -1 && html.indexOf('src="install.js"') < html.indexOf('src="follow.js"'));
  assert.match(html, /id="notify-toggle"/); // the toggle that is hidden when only the install hint is shown
});
