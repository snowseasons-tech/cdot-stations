import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { RateLimiter } from '../auth.js';
import { MAX_SUBSCRIPTIONS } from '../push.js';

const CONFIG = { publicKey: 'BPublicKeyForTests', privateKey: 'private', subject: 'mailto:team@example.com' };
const KEYS = { p256dh: 'B' + 'x'.repeat(86), auth: 'a'.repeat(22) };
const device = (letter) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${letter}`, keys: KEYS });

async function start(t, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-'));
  const sent = [];
  const server = await createApp({
    statusFile: join(dir, 'status.json'), subscriptionsFile: join(dir, 'subscriptions.json'), token: 'secret',
    pushConfig: CONFIG, pushSender: async (s, payload) => { sent.push({ to: s.endpoint.slice(-1), ...JSON.parse(payload) }); }, ...opts,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const follow = (letter, stations) => post('/api/push/subscribe', { subscription: device(letter), stations });
  const put = (id, body) => fetch(`${base}/api/stations/${id}/status`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify(body) });
  return { base, server, sent, post, follow, put, idle: () => server.push.notifier.idle() };
}

test('push is off (503) when the keys are not configured, and the rest of the app is unaffected', async (t) => {
  const { base, post } = await start(t, { pushConfig: null });
  assert.equal((await fetch(`${base}/api/push/key`)).status, 503);
  assert.equal((await post('/api/push/subscribe', {})).status, 503);
  assert.equal((await fetch(`${base}/api/stations`)).status, 200);
});

test('serves the public key, and follow / following / unfollow work', async (t) => {
  const { base, follow, post } = await start(t);
  assert.deepEqual(await (await fetch(`${base}/api/push/key`)).json(), { publicKey: 'BPublicKeyForTests' });

  assert.deepEqual(await (await follow('a', ['limon', 'cortez'])).json(), { stations: ['limon', 'cortez'] });
  assert.deepEqual(await (await post('/api/push/following', { endpoint: device('a').endpoint })).json(), { stations: ['limon', 'cortez'] });
  assert.deepEqual(await (await post('/api/push/following', { endpoint: device('zzz').endpoint })).json(), { stations: [] });

  assert.deepEqual(await (await follow('a', ['all'])).json(), { stations: ['all'] }); // change what it follows
  assert.equal((await (await post('/api/push/unsubscribe', { endpoint: device('a').endpoint })).json()).removed, true);
  assert.deepEqual(await (await post('/api/push/following', { endpoint: device('a').endpoint })).json(), { stations: [] });
  assert.deepEqual(await (await follow('b', [])).json(), { stations: [], removed: false }); // empty list = unfollow, nothing stored
});

test('bad input, forged requests and wrong methods are refused', async (t) => {
  const { base, post, follow } = await start(t);
  assert.equal((await post('/api/push/subscribe', { subscription: { endpoint: 'https://evil.example/x', keys: KEYS }, stations: ['limon'] })).status, 400);
  assert.equal((await post('/api/push/subscribe', { subscription: { endpoint: 'http://169.254.169.254/x', keys: KEYS }, stations: ['limon'] })).status, 400);
  assert.equal((await follow('a', ['nowhere'])).status, 400);
  assert.equal((await post('/api/push/subscribe', '{not json')).status, 400);
  assert.equal((await post('/api/push/following', { endpoint: 'https://evil.example/x' })).status, 400);
  assert.equal((await post('/api/push/subscribe', 'x'.repeat(5000))).status, 400); // body over 4 KB

  const plain = await fetch(`${base}/api/push/subscribe`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ subscription: device('a'), stations: ['all'] }) });
  assert.equal(plain.status, 415); // a cross-site form can only send simple types, so this blocks forged subscriptions
  assert.equal((await post('/api/push/subscribe', { subscription: device('a'), stations: ['all'] }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post('/api/push/subscribe', { subscription: device('a'), stations: ['all'] }, { 'sec-fetch-site': 'same-origin' })).status, 200);

  assert.equal((await fetch(`${base}/api/push/subscribe`)).status, 405);
  assert.equal((await fetch(`${base}/api/push/nothing`, { method: 'POST' })).status, 404);
});

test('push requests are rate limited per client', async (t) => {
  const { post } = await start(t, { pushLimiter: new RateLimiter({ max: 5, windowMs: 60_000 }) });
  for (let i = 0; i < 5; i++) assert.equal((await post('/api/push/following', { endpoint: device('a').endpoint })).status, 200);
  const limited = await post('/api/push/following', { endpoint: device('a').endpoint });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('the subscription cap is a 503, not a crash', async (t) => {
  const { server, follow } = await start(t);
  for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) server.push.subscriptions.state.subscriptions[`k${i}`] = { endpoint: `https://fcm.googleapis.com/fcm/send/f${i}`, keys: KEYS, stations: ['all'] };
  const r = await follow('new', ['limon']);
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /limit/);
});

test('a status or note change notifies exactly the followers of that station', async (t) => {
  const { follow, put, sent, idle } = await start(t);
  await follow('a', ['limon']);
  await follow('b', ['cortez']);
  await follow('c', ['all']);

  assert.equal((await put('limon', { status: 'open', note: 'No wait' })).status, 200);
  await idle();
  assert.deepEqual(sent.map((m) => m.to).sort(), ['a', 'c']);
  assert.deepEqual(sent.find((m) => m.to === 'a'), { to: 'a', title: 'Limon: Open', body: 'No wait', tag: 'limon', url: '/?station=limon' });

  sent.length = 0;
  await put('limon', { status: 'open', note: 'No wait' });            // repeat: nothing changed
  await put('limon', { status: 'open', note: 'Short wait' });         // note changed
  await idle();
  assert.deepEqual(sent.map((m) => `${m.to}:${m.title}`).sort(), ['a:Limon: note updated', 'c:Limon: note updated']);

  sent.length = 0;
  await put('dumont', { status: 'closed' });                          // nobody follows Dumont except "all"
  await idle();
  assert.deepEqual(sent.map((m) => m.to), ['c']);
});

test('imports notify too, and unchanged imports do not', async (t) => {
  const { base, follow, sent, idle } = await start(t);
  await follow('a', ['cortez']);
  const records = { source: 'csp', records: [{ station: 'cortez', status: 'closed', note: 'Scale down' }] };
  const imp = () => fetch(`${base}/api/import`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify(records) });
  await imp(); await idle();
  assert.equal(sent.length, 1);
  await imp(); await idle(); // identical: the importer skips it, so no event
  assert.equal(sent.length, 1);
});

test('a failing push service never fails or delays the status update', async (t) => {
  const { follow, put, idle } = await start(t, { pushSender: async () => { throw Object.assign(new Error('push service down'), { statusCode: 503 }); } });
  const originalError = console.error; console.error = () => {};
  try {
    await follow('a', ['limon']);
    const r = await put('limon', { status: 'open' });
    assert.equal(r.status, 200);
    await idle();
  } finally { console.error = originalError; }
});

test('a device that the push service reports gone is removed after the next change', async (t) => {
  const { server, follow, put, post, idle } = await start(t, { pushSender: async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); } });
  await follow('a', ['limon']);
  await put('limon', { status: 'open' });
  await idle();
  assert.deepEqual(await (await post('/api/push/following', { endpoint: device('a').endpoint })).json(), { stations: [] });
  assert.equal(server.push.subscriptions.count(), 0);
});
