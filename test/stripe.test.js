import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { loadStripeConfig, createCheckoutSession, fetchOffer, verifyWebhook, StripeError, PRODUCT } from '../stripe.js';

const SECRET = 'whsec_test123456';
const ENV = {
  STRIPE_SECRET_KEY: 'sk_test_abc123', STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_PRICE_FOUNDING: 'price_abc123',
  JOIN_BASE_URL: 'https://join.example.com', JOIN_TERMS_URL: 'https://example.com/terms', JOIN_REFUND_URL: 'https://example.com/refunds', JOIN_PRIVACY_URL: 'https://example.com/privacy',
};
const sign = (body, secret = SECRET, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

test('selling is off with no settings, and a partial or wrong configuration is refused loudly', () => {
  assert.equal(loadStripeConfig({}), null);
  const ok = loadStripeConfig(ENV);
  assert.deepEqual([ok.priceId, ok.baseUrl, ok.joinHost, ok.live], ['price_abc123', 'https://join.example.com', 'join.example.com', false]);
  assert.throws(() => loadStripeConfig({ STRIPE_SECRET_KEY: 'sk_test_abc' }), /also set: STRIPE_WEBHOOK_SECRET/);
  const bad = (patch, pattern) => assert.throws(() => loadStripeConfig({ ...ENV, ...patch }), pattern, JSON.stringify(patch));
  bad({ STRIPE_SECRET_KEY: 'not-a-key' }, /secret key/);
  bad({ STRIPE_SECRET_KEY: 'pk_test_abc123' }, /secret key/);                       // a publishable key is not a secret key
  bad({ STRIPE_WEBHOOK_SECRET: 'nope' }, /whsec_/);
  bad({ STRIPE_PRICE_FOUNDING: 'prod_abc' }, /price_/);                              // a product id is not a price id
  bad({ JOIN_BASE_URL: 'http://join.example.com' }, /https/);
  bad({ JOIN_BASE_URL: 'not a url' }, /web address/);
  bad({ JOIN_TERMS_URL: 'http://example.com/terms' }, /JOIN_TERMS_URL must be an https/);
  bad({ JOIN_REFUND_URL: 'javascript:alert(1)' }, /JOIN_REFUND_URL must be an https/);
  assert.equal(loadStripeConfig({ ...ENV, JOIN_BASE_URL: 'http://localhost:3000' }).joinHost, 'localhost:3000'); // plain http only for local tests
});

test('a live key is refused unless ALLOW_LIVE=1, so a test deployment cannot take real money', () => {
  const live = { ...ENV, STRIPE_SECRET_KEY: 'sk_live_abc123' };
  assert.throws(() => loadStripeConfig(live), /live key; set ALLOW_LIVE=1/);
  assert.throws(() => loadStripeConfig({ ...live, ALLOW_LIVE: 'true' }), /ALLOW_LIVE=1/);
  assert.equal(loadStripeConfig({ ...live, ALLOW_LIVE: '1' }).live, true);
});

test('verifyWebhook accepts a correctly signed event', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });
  const event = verifyWebhook(Buffer.from(body), sign(body), SECRET);
  assert.equal(event.id, 'evt_1');
  // Stripe sends several v1 signatures while a secret is being rotated; any valid one is enough
  const rotating = `${sign(body, 'whsec_old')},v1=${sign(body).split('v1=')[1]}`;
  assert.equal(verifyWebhook(Buffer.from(body), rotating.replace(/t=\d+,/, `t=${sign(body).match(/t=(\d+)/)[1]},`), SECRET).id, 'evt_1');
});

test('verifyWebhook rejects forged, altered, replayed and malformed webhooks', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const reject = (raw, header, pattern, opts) => assert.throws(() => verifyWebhook(raw, header, SECRET, opts), (e) => e instanceof StripeError && e.status === 400 && pattern.test(e.message), String(header).slice(0, 40));

  reject(Buffer.from(body), sign(body, 'whsec_someone_else'), /does not match/);                  // signed with the wrong secret
  reject(Buffer.from(body.replace('evt_1', 'evt_2')), sign(body), /does not match/);               // body changed after signing
  reject(Buffer.from(body), sign(body, SECRET, Math.floor(Date.now() / 1000) - 3600), /tolerance/); // an hour-old signature is a replay
  reject(Buffer.from(body), sign(body, SECRET, Math.floor(Date.now() / 1000) + 3600), /tolerance/); // and so is one from the future
  reject(Buffer.from(body), undefined, /missing/);
  reject(Buffer.from(body), '', /malformed/);
  reject(Buffer.from(body), 't=abc,v1=00', /malformed/);
  reject(Buffer.from(body), `t=${Math.floor(Date.now() / 1000)}`, /malformed/);                   // no signature at all
  reject(Buffer.from(body), `t=${Math.floor(Date.now() / 1000)},v1=zz`, /does not match/);         // not even hex
  reject(Buffer.from(body), `t=${Math.floor(Date.now() / 1000)},v1=`, /malformed/);
  reject(body, sign(body), /missing/);                                                              // must be the raw bytes, not a parsed or re-encoded string
  const notJson = 'not json at all';
  reject(Buffer.from(notJson), sign(notJson), /not JSON/);                                          // correctly signed, but not an event
  // a signature of the right length for a different body, with the right secret, is still refused
  reject(Buffer.from(body + ' '), sign(body), /does not match/);
});

async function fakeStripe(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
    requests.push(record);
    const { status = 200, json } = handler(record);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { requests, config: { ...loadStripeConfig(ENV), apiBase: `http://127.0.0.1:${server.address().port}` } };
}

test('createCheckoutSession sends the price id, our product tag and the return pages, and the key only in the header', async (t) => {
  const { config, requests } = await fakeStripe(t, () => ({ json: { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' } }));
  assert.equal(await createCheckoutSession(config), 'https://checkout.stripe.com/c/pay/cs_1');
  const r = requests[0];
  assert.deepEqual([r.method, r.url], ['POST', '/v1/checkout/sessions']);
  assert.equal(r.headers.authorization, 'Bearer sk_test_abc123');
  const form = new URLSearchParams(r.body);
  assert.deepEqual([form.get('mode'), form.get('line_items[0][price]'), form.get('line_items[0][quantity]')], ['payment', 'price_abc123', '1']);
  assert.deepEqual([form.get('success_url'), form.get('cancel_url')], ['https://join.example.com/join/thanks', 'https://join.example.com/join']);
  assert.equal(form.get('metadata[product]'), PRODUCT);
  assert.ok(!r.body.includes('sk_test_abc123'), 'the secret key must never be in the body');
  assert.ok(![...form.keys()].some((k) => k.includes('unit_amount')), 'the amount comes from the Stripe price, never from us');
});

test('Stripe errors are reported without leaking Stripe\'s message or the key; a bad checkout address is refused', async (t) => {
  const failing = await fakeStripe(t, () => ({ status: 401, json: { error: { type: 'invalid_request_error', message: 'Invalid API Key provided: sk_test_abc123' } } }));
  await assert.rejects(createCheckoutSession(failing.config), (e) => e instanceof StripeError && e.status === 401 && e.message === 'Stripe returned 401: invalid_request_error' && !e.message.includes('sk_'));
  const odd = await fakeStripe(t, () => ({ json: { id: 'cs_1', url: 'http://evil.example/pay' } }));
  await assert.rejects(createCheckoutSession(odd.config), /checkout address/);          // http, so refused
  const none = await fakeStripe(t, () => ({ json: { id: 'cs_1' } }));
  await assert.rejects(createCheckoutSession(none.config), /checkout address/);
  await assert.rejects(createCheckoutSession({ ...none.config, apiBase: 'http://127.0.0.1:1' }), (e) => e.status === 502 && /could not reach Stripe/.test(e.message));
});

test('fetchOffer reads the price from Stripe and refuses anything that is not an active one-time price', async (t) => {
  const good = await fakeStripe(t, () => ({ json: { active: true, type: 'one_time', unit_amount: 29900, currency: 'usd' } }));
  assert.deepEqual(await fetchOffer(good.config), { amount: 29900, currency: 'usd' });
  assert.equal(good.requests[0].url, '/v1/prices/price_abc123');
  for (const price of [{ active: false, type: 'one_time', unit_amount: 100, currency: 'usd' }, { active: true, type: 'recurring', unit_amount: 100, currency: 'usd' },
    { active: true, type: 'one_time', unit_amount: 0, currency: 'usd' }, { active: true, type: 'one_time', unit_amount: 1.5, currency: 'usd' }, { active: true, type: 'one_time', currency: 'usd' }]) {
    const s = await fakeStripe(t, () => ({ json: price }));
    await assert.rejects(fetchOffer(s.config), /active one-time price/, JSON.stringify(price));
  }
});
