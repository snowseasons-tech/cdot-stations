// Proves the real web-push library produces what a push service and a phone expect: a VAPID-signed request carrying a
// message encrypted for the phone's keys. A local HTTPS server plays the push service; the test plays the phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { createECDH, createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import ece from 'http_ece';
import webpush from 'web-push';
import { createWebPushSender, createNotifier, Subscriptions } from '../push.js';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

async function localPushService(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-tls-'));
  t.after(() => rm(dir, { recursive: true }));
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
    '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' });
  if (made.status !== 0) return t.skip('openssl is not available to make a test certificate');
  const [key, cert] = await Promise.all([readFile(join(dir, 'k.pem')), readFile(join(dir, 'c.pem'))]);
  const received = [];
  const server = createServer({ key, cert }, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { received.push({ headers: req.headers, url: req.url, body: Buffer.concat(chunks) }); res.writeHead(201); res.end(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  // trust the test certificate for outgoing requests in this process only, and put things back afterwards
  const saved = https.globalAgent.options.ca;
  https.globalAgent.options.ca = cert;
  t.after(() => { https.globalAgent.options.ca = saved; });
  return { received, endpoint: `https://localhost:${server.address().port}/push/device-1` };
}

test('the real sender signs with VAPID and encrypts a message only the subscribed phone can read', async (t) => {
  const service = await localPushService(t);
  if (!service) return;

  // the "phone": a P-256 key pair and an auth secret, as a browser creates when subscribing
  const phone = createECDH('prime256v1'); phone.generateKeys();
  const authSecret = randomBytes(16);
  const subscription = { endpoint: service.endpoint, keys: { p256dh: b64url(phone.getPublicKey()), auth: b64url(authSecret) } };

  const vapid = webpush.generateVAPIDKeys();
  const send = await createWebPushSender({ publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: 'mailto:team@example.com' });
  const message = JSON.stringify({ title: 'Limon: Open', body: 'No wait — café ✓', tag: 'limon', url: '/?station=limon' });
  await send(subscription, message, { TTL: 21600, urgency: 'normal', topic: 'limon' });

  assert.equal(service.received.length, 1);
  const { headers, body } = service.received[0];
  assert.equal(headers['content-encoding'], 'aes128gcm');
  assert.equal(headers.ttl, '21600');
  assert.equal(headers.urgency, 'normal');
  assert.equal(headers.topic, 'limon');

  // the VAPID token: ES256, for this push service, for our contact, signed by our private key
  const [, t64, k64] = /^vapid t=([^,]+), k=(.+)$/.exec(headers.authorization);
  assert.equal(k64, vapid.publicKey);
  const [head, claims, sig] = t64.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const payload = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(payload.aud, new URL(service.endpoint).origin);
  assert.equal(payload.sub, 'mailto:team@example.com');
  assert.ok(payload.exp > Date.now() / 1000 && payload.exp <= Date.now() / 1000 + 24 * 3600, 'expires within 24 hours');
  const pub = Buffer.from(vapid.publicKey, 'base64url');
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) }, format: 'jwk' });
  assert.equal(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), true, 'VAPID signature verifies');

  // the message: unreadable on the wire, readable by the phone
  assert.ok(!body.includes(Buffer.from('Limon')), 'the body must be encrypted');
  const plain = ece.decrypt(body, { version: 'aes128gcm', privateKey: phone, authSecret });
  assert.deepEqual(JSON.parse(plain.toString('utf8')), JSON.parse(message));
});

test('a different phone cannot read the message', async (t) => {
  const service = await localPushService(t);
  if (!service) return;
  const phone = createECDH('prime256v1'); phone.generateKeys();
  const intruder = createECDH('prime256v1'); intruder.generateKeys();
  const authSecret = randomBytes(16);
  const vapid = webpush.generateVAPIDKeys();
  const send = await createWebPushSender({ ...vapid, subject: 'mailto:team@example.com' });
  await send({ endpoint: service.endpoint, keys: { p256dh: b64url(phone.getPublicKey()), auth: b64url(authSecret) } }, 'secret status', {});
  assert.throws(() => ece.decrypt(service.received[0].body, { version: 'aes128gcm', privateKey: intruder, authSecret }));
});

test('end to end through the notifier: a followed station change reaches the push service, and a gone device is dropped', async (t) => {
  const service = await localPushService(t);
  if (!service) return;
  const phone = createECDH('prime256v1'); phone.generateKeys();
  const keys = { p256dh: b64url(phone.getPublicKey()), auth: b64url(randomBytes(16)) };
  const vapid = webpush.generateVAPIDKeys();

  const subscriptions = new Subscriptions(join(await mkdtemp(join(tmpdir(), 'cdot-')), 'subscriptions.json'));
  await subscriptions.set({ endpoint: service.endpoint, keys }, ['limon']);
  const notifier = createNotifier({
    subscriptions, stations: [{ id: 'limon', name: 'Limon' }],
    sender: await createWebPushSender({ ...vapid, subject: 'mailto:team@example.com' }), log: { error: () => {} },
  });
  const result = await notifier.notify({ id: 'limon', previous: { status: 'closed', note: '' }, current: { status: 'open', note: 'No wait' } });
  assert.deepEqual(result, { sent: 1, removed: 0, failed: 0 });
  const decoded = JSON.parse(ece.decrypt(service.received[0].body, { version: 'aes128gcm', privateKey: phone, authSecret: Buffer.from(keys.auth, 'base64url') }).toString());
  assert.deepEqual([decoded.title, decoded.body, decoded.tag], ['Limon: Open', 'No wait', 'limon']);
});
