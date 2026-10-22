import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import {
  isPushEndpoint, validateRequest, Subscriptions, buildMessage, createNotifier, loadPushConfig, MAX_SUBSCRIPTIONS,
} from '../push.js';

const P256DH = 'B' + 'x'.repeat(86); // 87 base64url characters, like a real key
const AUTH = 'a'.repeat(22);
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';
const sub = (endpoint = ENDPOINT) => ({ endpoint, keys: { p256dh: P256DH, auth: AUTH } });
const ids = new Set(['limon', 'cortez', 'dumont']);

async function tmp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-'));
  t.after(() => rm(dir, { recursive: true }));
  return dir;
}

test('only real push services are accepted as endpoints (otherwise the server could be aimed anywhere)', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QAbc', 'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ]) assert.equal(isPushEndpoint(ok), true, ok);
  for (const bad of [
    'http://fcm.googleapis.com/fcm/send/abc', // not https
    'https://localhost/x', 'https://127.0.0.1/x', 'https://192.168.0.20:8080/x', 'https://[::1]/x', 'https://169.254.169.254/latest/meta-data',
    'https://fcm.googleapis.com.evil.example/x', 'https://evilfcm.googleapis.com/x', 'https://evil.example/fcm.googleapis.com',
    'https://user:pass@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'ftp://fcm.googleapis.com/x',
    'https://notify.windows.com.evil.example/x', '', 'not a url', null, 42, `https://fcm.googleapis.com/${'a'.repeat(1000)}`,
  ]) assert.equal(isPushEndpoint(bad), false, String(bad).slice(0, 60));
});

test('validateRequest accepts a good subscription and rejects malformed ones with a clear message', () => {
  const ok = validateRequest({ subscription: sub(), stations: ['limon', 'limon', 'cortez'] }, ids);
  assert.deepEqual(ok.stations, ['limon', 'cortez']); // de-duplicated
  assert.deepEqual(validateRequest({ subscription: sub(), stations: ['all'] }, ids).stations, ['all']);
  assert.deepEqual(validateRequest({ subscription: sub(), stations: [] }, ids).stations, []);

  const bad = (body, pattern) => assert.throws(() => validateRequest(body, ids), (e) => e instanceof RangeError && pattern.test(e.message));
  bad({}, /endpoint/);
  bad({ subscription: sub('https://evil.example/x'), stations: ['limon'] }, /endpoint/);
  bad({ subscription: { endpoint: ENDPOINT, keys: { p256dh: 'short', auth: AUTH } }, stations: ['limon'] }, /p256dh/);
  bad({ subscription: { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: 'bad key!' } }, stations: ['limon'] }, /auth/);
  bad({ subscription: sub(), stations: 'limon' }, /array/);
  bad({ subscription: sub(), stations: ['nowhere'] }, /unknown station/);
  bad({ subscription: sub(), stations: ['all', 'limon'] }, /cannot be combined/);
  bad({ subscription: sub(), stations: Array.from({ length: 51 }, (_, i) => `s${i}`) }, /array/);
});

test('subscriptions are stored, updated, found by station, removed, and survive a restart', async (t) => {
  const file = join(await tmp(t), 'subscriptions.json');
  const s = new Subscriptions(file);
  await s.load(); // no file yet
  await s.set(sub('https://fcm.googleapis.com/fcm/send/a'), ['limon']);
  await s.set(sub('https://fcm.googleapis.com/fcm/send/b'), ['all']);
  await s.set(sub('https://fcm.googleapis.com/fcm/send/c'), ['cortez']);
  assert.deepEqual(s.forStation('limon').map((x) => x.endpoint.slice(-1)).sort(), ['a', 'b']);
  assert.deepEqual(s.forStation('cortez').map((x) => x.endpoint.slice(-1)).sort(), ['b', 'c']);
  assert.deepEqual(s.following('https://fcm.googleapis.com/fcm/send/a'), ['limon']);
  assert.deepEqual(s.following('https://fcm.googleapis.com/fcm/send/unknown'), []);

  await s.set(sub('https://fcm.googleapis.com/fcm/send/a'), ['limon', 'dumont']); // update, not a new subscription
  assert.equal(s.count(), 3);

  const reloaded = new Subscriptions(file);
  await reloaded.load();
  assert.equal(reloaded.count(), 3);
  assert.deepEqual(reloaded.following('https://fcm.googleapis.com/fcm/send/a'), ['limon', 'dumont']);

  assert.equal((await reloaded.set(sub('https://fcm.googleapis.com/fcm/send/a'), [])).removed, true); // empty list unfollows
  assert.equal(reloaded.count(), 2);
  assert.equal((await reloaded.remove('https://fcm.googleapis.com/fcm/send/never-existed')).removed, false);
});

test('the subscription limit is enforced for new devices only', async (t) => {
  const s = new Subscriptions(join(await tmp(t), 'subscriptions.json'));
  for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) s.state.subscriptions[`k${i}`] = { endpoint: `https://fcm.googleapis.com/fcm/send/${i}`, keys: {}, stations: ['all'] };
  await assert.rejects(s.set(sub('https://fcm.googleapis.com/fcm/send/new'), ['limon']), /limit/);
  const existing = { endpoint: 'https://fcm.googleapis.com/fcm/send/0', keys: sub().keys };
  s.state.subscriptions[Subscriptions.key(existing.endpoint)] = { ...existing, stations: ['all'], createdAt: 'x' };
  await s.set(existing, ['limon']); // an existing device can still change what it follows
});

test('notification text says what changed', () => {
  const limon = { id: 'limon', name: 'Limon' };
  const prev = { status: 'closed', note: '' };
  assert.deepEqual(buildMessage(limon, prev, { status: 'open', note: 'No wait' }), { title: 'Limon: Open', body: 'No wait', tag: 'limon', url: '/?station=limon' });
  assert.equal(buildMessage(limon, prev, { status: 'open', note: '' }).body, 'Was closed.');
  assert.equal(buildMessage(limon, { status: 'open', note: 'a' }, { status: 'open', note: 'b' }).title, 'Limon: note updated');
  assert.equal(buildMessage(limon, { status: 'open', note: 'a' }, { status: 'open', note: '' }).body, 'Note cleared.');
  assert.equal(buildMessage(limon, prev, { status: 'unknown', note: '' }).title, 'Limon: Status unknown');
});

async function notifierWith(t, followers, sender) {
  const subs = new Subscriptions(join(await tmp(t), 'subscriptions.json'));
  for (const [letter, stations] of Object.entries(followers)) await subs.set(sub(`https://fcm.googleapis.com/fcm/send/${letter}`), stations);
  const logs = [];
  const notifier = createNotifier({ subscriptions: subs, stations: [{ id: 'limon', name: 'Limon' }, { id: 'cortez', name: 'Cortez' }], sender, log: { error: (m) => logs.push(m) } });
  return { subs, notifier, logs };
}
const change = (id = 'limon') => ({ id, previous: { status: 'closed', note: '' }, current: { status: 'open', note: 'No wait' } });

test('only followers of the changed station (and "all" followers) are notified', async (t) => {
  const sent = [];
  const { notifier } = await notifierWith(t, { a: ['limon'], b: ['cortez'], c: ['all'], d: ['limon', 'cortez'] }, async (s, payload, opts) => { sent.push({ to: s.endpoint.slice(-1), payload: JSON.parse(payload), opts }); });
  const result = await notifier.notify(change('limon'));
  assert.deepEqual(sent.map((x) => x.to).sort(), ['a', 'c', 'd']);
  assert.equal(result.sent, 3);
  assert.equal(sent[0].payload.title, 'Limon: Open');
  assert.equal(sent[0].opts.topic, 'limon');
  assert.ok(sent[0].opts.TTL > 0);
  assert.deepEqual((await notifier.notify(change('unknown-station'))), { sent: 0, removed: 0, failed: 0 });
});

test('a device the push service reports gone (404/410) is dropped; other failures are logged and kept', async (t) => {
  const { notifier, subs, logs } = await notifierWith(t, { a: ['limon'], b: ['limon'], c: ['limon'], d: ['limon'] }, async (s) => {
    const l = s.endpoint.slice(-1);
    if (l === 'a') throw Object.assign(new Error('gone'), { statusCode: 410 });
    if (l === 'b') throw Object.assign(new Error('not found'), { statusCode: 404 });
    if (l === 'c') throw Object.assign(new Error('server error'), { statusCode: 500 });
  });
  const result = await notifier.notify(change());
  assert.deepEqual(result, { sent: 1, removed: 2, failed: 1 });
  assert.equal(subs.count(), 2); // a and b removed; c (temporary failure) and d kept
  assert.equal(logs.length, 1);
  assert.match(logs[0], /fcm\.googleapis\.com failed: 500/);
  assert.doesNotMatch(logs[0], /abc123|send\/c/); // the log names the service, not the device's private address
});

test('notify never throws, and idle() waits for sends in flight', async (t) => {
  let release; const gate = new Promise((r) => { release = r; });
  let delivered = 0;
  const { notifier } = await notifierWith(t, { a: ['limon'] }, async () => { await gate; delivered++; });
  notifier.notify(change()); // not awaited, as the server does
  assert.equal(delivered, 0);
  release();
  await notifier.idle();
  assert.equal(delivered, 1);
});

test('the store reports real changes to status or note, once saved, and never fails the write because of the hook', async (t) => {
  const events = [];
  const store = new Store(join(await tmp(t), 'status.json'), { onChange: (e) => events.push(e) });
  await store.set('limon', { status: 'unknown' });                       // nothing stored, nothing new: no event
  await store.set('limon', { status: 'open', note: 'No wait' });         // first report
  await store.set('limon', { status: 'open', note: 'No wait' });         // identical repeat: no event
  await store.set('limon', { status: 'open', note: '  No wait  ' });     // same after trimming: no event
  await store.set('limon', { status: 'open', note: 'Short wait' });      // note only
  await store.set('limon', { status: 'closed', note: 'Short wait' });    // status only
  assert.deepEqual(events.map((e) => [e.previous.status + '/' + e.previous.note, e.current.status + '/' + e.current.note]), [
    ['unknown/', 'open/No wait'], ['open/No wait', 'open/Short wait'], ['open/Short wait', 'closed/Short wait'],
  ]);

  const exploding = new Store(join(await tmp(t), 'status.json'), { onChange: () => { throw new Error('boom'); } });
  const original = console.error; console.error = () => {};
  try { await exploding.set('limon', { status: 'open' }); } finally { console.error = original; }
  assert.equal(exploding.get('limon').status, 'open'); // the write still happened
});

test('push config is all-or-nothing and validated', () => {
  assert.equal(loadPushConfig({}), null);
  assert.deepEqual(loadPushConfig({ VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'k', VAPID_SUBJECT: 'mailto:team@example.com' }), { publicKey: 'p', privateKey: 'k', subject: 'mailto:team@example.com' });
  assert.throws(() => loadPushConfig({ VAPID_PUBLIC_KEY: 'p' }), /also set: VAPID_PRIVATE_KEY, VAPID_SUBJECT/);
  assert.throws(() => loadPushConfig({ VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'k', VAPID_SUBJECT: 'team@example.com' }), /mailto:/);
});
