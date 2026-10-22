import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { FailureLimiter, tokenMatches } from '../auth.js';

async function start(t, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-'));
  const server = await createApp({ statusFile: join(dir, 'status.json'), ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}
const put = (base, headers = {}) =>
  fetch(`${base}/api/stations/limon/status`, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ status: 'open' }) });

test('tokenMatches accepts only the exact bearer token', () => {
  assert.equal(tokenMatches('Bearer s3cret', 's3cret'), true);
  assert.equal(tokenMatches('Bearer s3cre', 's3cret'), false);
  assert.equal(tokenMatches('Bearer s3cret2', 's3cret'), false);
  assert.equal(tokenMatches('s3cret', 's3cret'), false);
  assert.equal(tokenMatches(undefined, 's3cret'), false);
  assert.equal(tokenMatches('', ''), false); // an empty configured token never matches a missing header
});

test('FailureLimiter locks a client out after max failures and releases it after the window', () => {
  let now = 0;
  const l = new FailureLimiter({ max: 3, windowMs: 1000, now: () => now });
  for (let i = 0; i < 2; i++) l.fail('a');
  assert.equal(l.retryAfter('a'), 0);
  l.fail('a');
  assert.equal(l.retryAfter('a'), 1);
  assert.equal(l.retryAfter('b'), 0);
  now = 1001;
  assert.equal(l.retryAfter('a'), 0);
});

test('repeated bad tokens lock the client out, even for the right token', async (t) => {
  const base = await start(t, { token: 'secret', limiter: new FailureLimiter({ max: 3 }) });
  for (let i = 0; i < 3; i++) assert.equal((await put(base, { authorization: 'Bearer nope' })).status, 401);
  const locked = await put(base, { authorization: 'Bearer secret' });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
});

test('lockout is per client via X-Real-IP only when the proxy is trusted', async (t) => {
  const trusted = await start(t, { token: 'secret', trustProxy: true, limiter: new FailureLimiter({ max: 2 }) });
  for (let i = 0; i < 2; i++) await put(trusted, { authorization: 'Bearer bad', 'x-real-ip': '10.0.0.1' });
  assert.equal((await put(trusted, { authorization: 'Bearer secret', 'x-real-ip': '10.0.0.1' })).status, 429);
  assert.equal((await put(trusted, { authorization: 'Bearer secret', 'x-real-ip': '10.0.0.2' })).status, 200);

  // untrusted: the header is ignored, so rotating it doesn't evade the lockout
  const untrusted = await start(t, { token: 'secret', limiter: new FailureLimiter({ max: 2 }) });
  for (let i = 0; i < 2; i++) await put(untrusted, { authorization: 'Bearer bad', 'x-real-ip': `10.0.0.${i}` });
  assert.equal((await put(untrusted, { authorization: 'Bearer secret', 'x-real-ip': '10.0.0.9' })).status, 429);
});

test('responses carry security headers; API responses are not cacheable', async (t) => {
  const base = await start(t);
  for (const path of ['/', '/api/stations', '/missing']) {
    const r = await fetch(base + path);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/, path);
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/, path);
    assert.equal(r.headers.get('strict-transport-security'), null, path);
  }
  assert.equal((await fetch(`${base}/api/stations`)).headers.get('cache-control'), 'no-store');
});

test('third-party scripts and styles are pinned with integrity hashes', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const external = html.match(/<(?:script|link)[^>]+https?:\/\/[^>]+>/g) ?? [];
  assert.equal(external.length, 2);
  for (const tag of external) {
    assert.match(tag, /integrity="sha256-[A-Za-z0-9+/]+=*"/, tag);
    assert.match(tag, /crossorigin/, tag);
    assert.match(tag, /@\d+\.\d+\.\d+/, `${tag} must pin an exact version`);
  }
});

test('the search page puts server data in as text, never as HTML', async () => {
  const js = await readFile(new URL('../public/search.js', import.meta.url), 'utf8');
  assert.equal(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|document\.write/.test(js), false);
});

test('the page never hands Leaflet a string to render as HTML', async () => {
  const js = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  // Leaflet sets string tooltip/popup content with innerHTML; data (place names, notes) must go in as DOM nodes.
  const stringContent = js.match(/\.bind(?:Tooltip|Popup)\(\s*[`'"]/g);
  assert.equal(stringContent, null, `string passed to bindTooltip/bindPopup: ${stringContent}`);
  assert.equal(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|document\.write/.test(js), false);
});
