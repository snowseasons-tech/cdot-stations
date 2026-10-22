import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { RateLimiter } from '../auth.js';
import { loadStripeConfig, PRODUCT } from '../stripe.js';

const SECRET = 'whsec_test123456';
const ENV = {
  STRIPE_SECRET_KEY: 'sk_test_abc123', STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_PRICE_FOUNDING: 'price_abc123',
  JOIN_BASE_URL: 'https://join.example.com', JOIN_TERMS_URL: 'https://example.com/terms', JOIN_REFUND_URL: 'https://example.com/refunds',
  JOIN_PRIVACY_URL: 'https://example.com/privacy', JOIN_TRACKER_URL: 'https://tracker.example.com',
};
const JOIN_HOST = 'join.example.com';

async function fakeStripe(t) {
  const requests = [];
  let failing = false;
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (failing) { res.writeHead(500); return res.end(JSON.stringify({ error: { type: 'api_error', message: 'boom sk_test_abc123' } })); }
    if (req.url.startsWith('/v1/prices/')) return res.end(JSON.stringify({ active: true, type: 'one_time', unit_amount: 29900, currency: 'usd' }));
    for (const _ of []) { /* body is not needed */ }
    req.resume();
    res.end(JSON.stringify({ id: 'cs_new', url: 'https://checkout.stripe.com/c/pay/cs_new' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { requests, fail: (on = true) => { failing = on; }, apiBase: `http://127.0.0.1:${server.address().port}` };
}

async function start(t, { selling = true, dir: existingDir, ...opts } = {}) {
  const dir = existingDir ?? await mkdtemp(join(tmpdir(), 'cdot-'));
  const stripe = await fakeStripe(t);
  const server = await createApp({
    statusFile: join(dir, 'status.json'), subscriptionsFile: join(dir, 'subs.json'), membersFile: join(dir, 'members.json'),
    token: 'secret', pushConfig: null,
    stripeConfig: selling ? { ...loadStripeConfig(ENV), apiBase: stripe.apiBase } : null, joinLimiter: new RateLimiter({ max: 10, windowMs: 60_000 }), ...opts,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); server.close(); if (!existingDir) await rm(dir, { recursive: true }); });
  const port = server.address().port;
  // node:http, because fetch won't let a test choose the Host header, and the public hostname is what is being tested
  const call = (path, { method = 'GET', host = `127.0.0.1:${port}`, headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: { host, ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }); });
    });
    req.on('error', reject);
    req.end(body);
  });
  const pub = (path, o = {}) => call(path, { host: JOIN_HOST, ...o });
  const json = { 'content-type': 'application/json' };
  const auth = { authorization: 'Bearer secret' };
  return { call, pub, json, auth, stripe, server, dir };
}

const sign = (body, secret = SECRET, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const event = (over = {}, session = {}) => JSON.stringify({
  id: 'evt_1', type: 'checkout.session.completed',
  data: { object: { id: 'cs_test_A1', mode: 'payment', payment_status: 'paid', amount_total: 29900, currency: 'usd', created: 1_700_000_000,
    customer_details: { email: 'Buyer@Example.COM ', name: 'A Buyer' }, metadata: { product: PRODUCT, access_months: 'lifetime' }, ...session } }, ...over,
});
const webhook = (ctx, body, signature = sign(body)) => ctx.pub('/api/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': signature, 'content-type': 'application/json' }, body });

test('with selling off, none of the sales routes exist and the tracker is unaffected', async (t) => {
  const ctx = await start(t, { selling: false });
  for (const path of ['/join', '/join/thanks', '/join/join.js', '/api/offer', '/api/checkout', '/api/stripe-webhook']) {
    assert.equal((await ctx.call(path, { method: path.startsWith('/api/c') || path.includes('webhook') ? 'POST' : 'GET' })).status, 404, path);
  }
  assert.equal((await ctx.call('/api/stations')).status, 200);
  assert.equal((await ctx.call('/')).status, 200);
});

test('the public hostname serves only the sales pages and Stripe\'s webhook; the tracker\'s data is never reachable on it', async (t) => {
  const ctx = await start(t);
  for (const path of ['/api/stations', '/api/stations/limon', '/api/stations/limon/history', '/api/inspection-locations', '/api/inspection-search?q=limon', '/search.js', '/api/push/key', '/api/import',
    '/api/members', '/app.js', '/index.html', '/manifest.webmanifest', '/sw.js', '/icons/icon-192.png', '/styles.css', '/data/stations.json', '/join/../app.js']) {
    assert.equal((await ctx.pub(path)).status, 404, path);
  }
  assert.equal((await ctx.pub('/api/members', { headers: ctx.auth })).status, 404);                 // even with the write token
  assert.equal((await ctx.pub('/api/stations/limon/status', { method: 'PUT', headers: { ...ctx.json, ...ctx.auth }, body: '{"status":"open"}' })).status, 404);

  const root = await ctx.pub('/');
  assert.deepEqual([root.status, root.headers.location], [302, '/join']);
  const page = await ctx.pub('/join');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.text, /<h1 id="name">/);                                                       // the name is filled in from the settings
  assert.doesNotMatch(page.text, /Founding Member|Lifetime|lifetime/);                              // the page itself makes no fixed promise
  assert.equal((await ctx.pub('/join/thanks')).status, 200);
  assert.equal((await ctx.pub('/join/join.js')).status, 200);
  assert.equal((await ctx.pub('/join/join.css')).status, 200);

  // while on the tracker's own hostname, the tracker works as before
  assert.equal((await ctx.call('/api/stations')).status, 200);
  assert.equal((await ctx.call('/api/members')).status, 401);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
});

test('the offer shows the price Stripe has, and checkout is unavailable (not wrong) when Stripe is down', async (t) => {
  const ctx = await start(t);
  const offer = (await ctx.pub('/api/offer')).json();
  assert.deepEqual([offer.name, offer.amount, offer.currency, offer.trackerUrl, offer.months], ['Founding Member', 29900, 'usd', 'https://tracker.example.com', null]);
  assert.match(offer.headline, /^Lifetime access to the CDOT Inspection Stations tracker/);
  assert.equal(offer.term, 'One payment. No renewals.');
  assert.equal(offer.termsUrl, 'https://example.com/terms');
  await ctx.pub('/api/offer');
  assert.equal(ctx.stripe.requests.filter((r) => r.startsWith('GET /v1/prices')).length, 1); // cached for ten minutes

  const down = await start(t);
  down.stripe.fail();
  const r = await down.pub('/api/offer');
  assert.equal(r.status, 503);
  assert.doesNotMatch(r.text, /sk_test|boom/);
});

test('checkout needs the agreement, JSON, a same-site request, and is rate limited; Stripe failures are generic', async (t) => {
  const ctx = await start(t);
  const checkout = (o = {}) => ctx.pub('/api/checkout', { method: 'POST', headers: ctx.json, body: JSON.stringify({ agreed: true }), ...o });

  const ok = await checkout();
  assert.equal(ok.status, 200);
  assert.equal(ok.json().url, 'https://checkout.stripe.com/c/pay/cs_new');

  assert.equal((await checkout({ body: '{}' })).status, 400);                                    // the terms were not agreed to
  assert.equal((await checkout({ body: JSON.stringify({ agreed: 'yes' }) })).status, 400);        // must be exactly true
  assert.equal((await checkout({ headers: { 'content-type': 'text/plain' } })).status, 415);     // what a cross-site form can send
  assert.equal((await checkout({ headers: { ...ctx.json, 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await ctx.pub('/api/checkout')).status, 405);
  assert.equal((await checkout({ body: 'x'.repeat(2000) })).status, 400);                         // oversized

  ctx.stripe.fail();
  const failed = await checkout();
  assert.equal(failed.status, 502);
  assert.doesNotMatch(failed.text, /sk_test|boom|api_error/);                                    // nothing from Stripe or the key reaches the visitor
  ctx.stripe.fail(false);

  const limited = await start(t, { joinLimiter: new RateLimiter({ max: 3, windowMs: 60_000 }) });
  for (let i = 0; i < 3; i++) assert.equal((await limited.pub('/api/checkout', { method: 'POST', headers: ctx.json, body: JSON.stringify({ agreed: true }) })).status, 200);
  const blocked = await limited.pub('/api/checkout', { method: 'POST', headers: ctx.json, body: JSON.stringify({ agreed: true }) });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
});

test('a verified paid webhook records the buyer once, however many times Stripe sends it', async (t) => {
  const ctx = await start(t);
  const body = event();
  const first = await webhook(ctx, body);
  assert.equal(first.status, 200);
  const list = (await ctx.call('/api/members', { headers: ctx.auth })).json().members;
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].sessionId, list[0].email, list[0].name, list[0].amount, list[0].currency, list[0].accessGranted, list[0].needsReview],
    ['cs_test_A1', 'buyer@example.com', 'A Buyer', 29900, 'usd', false, false]);       // the email is trimmed and lower-cased
  assert.equal(list[0].paidAt, '2023-11-14T22:13:20.000Z');

  await webhook(ctx, body);                                                                  // the same event again
  await webhook(ctx, event({ id: 'evt_2', type: 'checkout.session.async_payment_succeeded' })); // another event for the same payment
  assert.equal((await ctx.call('/api/members', { headers: ctx.auth })).json().members.length, 1);
});

test('forged, replayed, unsigned and oversized webhooks are refused and record nothing', async (t) => {
  const ctx = await start(t);
  const count = async () => (await ctx.call('/api/members', { headers: ctx.auth })).json().members.length;
  const body = event();
  assert.equal((await webhook(ctx, body, sign(body, 'whsec_attacker'))).status, 400);          // signed with a guessed secret
  assert.equal((await webhook(ctx, body, sign(body, SECRET, Math.floor(Date.now() / 1000) - 3600))).status, 400); // replay of an old one
  assert.equal((await ctx.pub('/api/stripe-webhook', { method: 'POST', headers: ctx.json, body })).status, 400);  // no signature at all
  assert.equal((await webhook(ctx, body.replace('29900', '1'), sign(body))).status, 400);       // altered after signing
  const big = JSON.stringify({ pad: 'x'.repeat(300_000) });
  assert.equal((await webhook(ctx, big)).status, 400);                                          // far larger than any Stripe event
  assert.equal((await ctx.pub('/api/stripe-webhook')).status, 405);
  assert.equal(await count(), 0);
  assert.equal((await webhook(ctx, body)).status, 200);                                         // the genuine one still works
  assert.equal(await count(), 1);
});

test('only paid purchases of this product are recorded; everything else is acknowledged and ignored', async (t) => {
  const ctx = await start(t);
  const count = async () => (await ctx.call('/api/members', { headers: ctx.auth })).json().members.length;
  const cases = [
    event({}, { payment_status: 'unpaid' }),                                       // checkout opened but not paid
    event({}, { metadata: { product: 'something-else' } }),                        // another product on the same Stripe account
    event({}, { metadata: {} }),
    event({}, { mode: 'subscription' }),
    event({ type: 'payment_intent.succeeded' }),                                   // an event type we don't use
    event({ type: 'checkout.session.expired' }),
    event({}, { id: 42 }),
  ];
  for (const body of cases) assert.equal((await webhook(ctx, body)).status, 200, body.slice(0, 80)); // 200 so Stripe doesn't keep resending
  assert.equal(await count(), 0);
});

test('a paid session without a usable email is recorded and flagged for review, never dropped', async (t) => {
  const ctx = await start(t);
  await webhook(ctx, event({ id: 'evt_a' }, { id: 'cs_test_NOEMAIL', customer_details: {} }));
  await webhook(ctx, event({ id: 'evt_b' }, { id: 'cs_test_BADEMAIL', customer_details: { email: 'not an email' } }));
  const list = (await ctx.call('/api/members?pending=1', { headers: ctx.auth })).json().members;
  assert.equal(list.length, 2);
  for (const m of list) assert.deepEqual([m.email, m.needsReview], [null, true]);
});

test('member records need the write token, can be filtered to those waiting, and granting access persists', async (t) => {
  const ctx = await start(t);
  await webhook(ctx, event({ id: 'evt_1' }, { id: 'cs_test_ONE' }));
  await webhook(ctx, event({ id: 'evt_2' }, { id: 'cs_test_TWO', customer_details: { email: 'two@example.com' } }));
  assert.equal((await ctx.call('/api/members')).status, 401);
  assert.equal((await ctx.call('/api/members', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await ctx.call('/api/members/cs_test_ONE/granted', { method: 'POST' })).status, 401);

  assert.equal((await ctx.call('/api/members?pending=1', { headers: ctx.auth })).json().members.length, 2);
  const granted = await ctx.call('/api/members/cs_test_ONE/granted', { method: 'POST', headers: ctx.auth });
  assert.equal(granted.status, 200);
  assert.deepEqual([granted.json().accessGranted, typeof granted.json().grantedAt], [true, 'string']);
  const again = await ctx.call('/api/members/cs_test_ONE/granted', { method: 'POST', headers: ctx.auth });
  assert.equal(again.json().grantedAt, granted.json().grantedAt);                        // granting twice changes nothing
  assert.deepEqual((await ctx.call('/api/members?pending=1', { headers: ctx.auth })).json().members.map((m) => m.sessionId), ['cs_test_TWO']);
  assert.equal((await ctx.call('/api/members/cs_test_NOPE/granted', { method: 'POST', headers: ctx.auth })).status, 404);
  assert.equal((await ctx.call('/api/members/not-a-session/granted', { method: 'POST', headers: ctx.auth })).status, 405); // not a session id, so not a route (like any POST to an unknown path)
  assert.equal((await ctx.call('/api/members/cs_test_ONE/granted', { headers: ctx.auth })).status, 405);
});

test('purchases and the access flag survive a restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-'));
  t.after(() => rm(dir, { recursive: true }));
  const first = await start(t, { dir });
  await webhook(first, event());
  await first.call('/api/members/cs_test_A1/granted', { method: 'POST', headers: first.auth });
  first.server.close(); first.server.closeAllConnections();
  const second = await start(t, { dir });
  const [m] = (await second.call('/api/members', { headers: second.auth })).json().members;
  assert.deepEqual([m.sessionId, m.accessGranted], ['cs_test_A1', true]);
  assert.equal((await webhook(second, event())).status, 200);                             // a delivery after the restart is still a duplicate
  assert.equal((await second.call('/api/members', { headers: second.auth })).json().members.length, 1);
});

test('the sales pages are self-contained, send people only to Stripe, and contain no secrets', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = (f) => readFile(new URL(`../public/join/${f}`, import.meta.url), 'utf8');
  const js = await read('join.js');
  assert.match(js, /endsWith\('\.stripe\.com'\)/);                                       // the redirect target is checked
  assert.match(js, /agreed: true/);
  for (const f of ['index.html', 'thanks.html', 'join.js', 'thanks.js', 'join.css']) {
    const text = await read(f);
    assert.doesNotMatch(text, /sk_(test|live)_|whsec_|pk_(test|live)_|innerHTML/, f);
  }
  const html = await read('index.html');
  for (const tag of html.match(/<a [^>]*target="_blank"[^>]*>/g) ?? []) assert.match(tag, /rel="noopener noreferrer"/);
  assert.match(html, /not run by, or affiliated with, CDOT/);                              // the honest framing stays on the page
  assert.match(html, /<button id="buy" type="button" disabled>/);                          // can't be pressed before the agreement is ticked
});

// ---- a time-limited offer (the $5 beta): the settings drive the wording, the checkout, and each purchase's expiry
const BETA = { ...ENV, JOIN_OFFER_NAME: 'Beta Member', JOIN_ACCESS_MONTHS: '12' };

test('a 12-month beta describes itself as one, never promises lifetime, and says it does not auto-renew', async (t) => {
  const stripe = await fakeStripe(t);
  const dir = await mkdtemp(join(tmpdir(), 'cdot-'));
  t.after(() => rm(dir, { recursive: true }));
  const server = await createApp({
    statusFile: join(dir, 's.json'), subscriptionsFile: join(dir, 'u.json'), membersFile: join(dir, 'm.json'), token: 'secret', pushConfig: null,
    stripeConfig: { ...loadStripeConfig(BETA), apiBase: stripe.apiBase },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  const get = (path, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: { host: JOIN_HOST, ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });

  const offer = JSON.parse((await get('/api/offer')).text);
  assert.deepEqual([offer.name, offer.months, offer.amount], ['Beta Member', 12, 29900]);
  assert.match(offer.headline, /^12 months of access/);
  assert.match(offer.term, /12 months from your purchase.*does not renew automatically.*not be charged again/);
  assert.match(offer.extra, /during your 12 months/);
  for (const text of Object.values(offer).filter((v) => typeof v === 'string')) assert.doesNotMatch(text, /lifetime|all future/i, text);

  // the term is stamped on the checkout session, so each purchase keeps the term it was sold with
  await get('/api/checkout', 'POST', { 'content-type': 'application/json' }, JSON.stringify({ agreed: true }));
  assert.ok(stripe.requests.some((r) => r.startsWith('POST /v1/checkout/sessions')));  // (the stamped term itself is checked in stripe.test.js)
});

test('a purchase carries its own term into an expiry date, and expired members are the ones to take off the sign-in list', async (t) => {
  const ctx = await start(t);
  const list = async (query = '') => (await ctx.call(`/api/members${query}`, { headers: ctx.auth })).json().members;
  const paid = (id, months, created) => event({ id: `evt_${id}` }, { id: `cs_test_${id}`, created, metadata: { product: PRODUCT, access_months: months } });

  await webhook(ctx, paid('LIFE', 'lifetime', 1_700_000_000));
  await webhook(ctx, paid('YEAR', '12', 1_700_000_000));                    // paid 2023-11-14, expires 2024-11-14
  await webhook(ctx, paid('NEW', '12', Math.floor(Date.now() / 1000)));     // paid just now, not expired
  await webhook(ctx, paid('ODD', 'forever', 1_700_000_000));                // a term we don't recognise
  const byId = Object.fromEntries((await list()).map((m) => [m.sessionId, m]));
  assert.deepEqual([byId.cs_test_LIFE.months, byId.cs_test_LIFE.expiresAt, byId.cs_test_LIFE.needsReview], [null, null, false]);
  assert.deepEqual([byId.cs_test_YEAR.months, byId.cs_test_YEAR.expiresAt], [12, '2024-11-14T22:13:20.000Z']);
  assert.equal(byId.cs_test_ODD.needsReview, true);                          // never guessed: flagged for a person
  assert.equal(byId.cs_test_ODD.expiresAt, null);

  // nobody is "expired" until they have been given access
  assert.equal((await list('?expired=1')).length, 0);
  for (const id of ['LIFE', 'YEAR', 'NEW']) await ctx.call(`/api/members/cs_test_${id}/granted`, { method: 'POST', headers: ctx.auth });
  assert.deepEqual((await list('?expired=1')).map((m) => m.sessionId), ['cs_test_YEAR']);   // lifetime and not-yet-expired are left alone

  const removed = await ctx.call('/api/members/cs_test_YEAR/removed', { method: 'POST', headers: ctx.auth });
  assert.equal(removed.status, 200);
  assert.deepEqual([removed.json().accessGranted, typeof removed.json().removedAt], [false, 'string']);
  assert.equal((await list('?expired=1')).length, 0);                                       // done, so no longer listed
  assert.ok(!(await list('?pending=1')).some((m) => m.sessionId === 'cs_test_YEAR'));      // and not waiting to be added again
  assert.equal((await ctx.call('/api/members/cs_test_YEAR/removed', { method: 'POST' })).status, 401);
  assert.equal((await ctx.call('/api/members/cs_test_NOPE/removed', { method: 'POST', headers: ctx.auth })).status, 404);
});
