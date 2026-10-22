// Selling the Founding Member membership through Stripe Checkout, without the Stripe package: creating a checkout
// session is one HTTPS request, and verifying a webhook is a documented HMAC check.
//
// Everything here is off unless all the settings are present. A live key is refused unless ALLOW_LIVE=1, so a test
// deployment can't take real money by accident.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const PRODUCT = 'cdot-founding-member'; // stamped on our checkout sessions so we only act on our own purchases
const SETTINGS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_FOUNDING', 'JOIN_BASE_URL', 'JOIN_TERMS_URL', 'JOIN_REFUND_URL', 'JOIN_PRIVACY_URL'];
const WEBHOOK_TOLERANCE_SECONDS = 300;

export class StripeError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const isHttps = (value) => { try { return new URL(value).protocol === 'https:'; } catch { return false; } };

// Returns the selling configuration, or null when none of the settings is present (selling is then off). Throws when it
// is partly or wrongly configured, so a typo can't half-enable it.
export function loadStripeConfig(env = process.env) {
  const present = SETTINGS.filter((name) => env[name]);
  if (!present.length) return null;
  const missing = SETTINGS.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Selling is partly configured; also set: ${missing.join(', ')}`);

  const secretKey = env.STRIPE_SECRET_KEY;
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(secretKey)) throw new Error('STRIPE_SECRET_KEY is not a Stripe secret key');
  const live = secretKey.includes('_live_');
  if (live && env.ALLOW_LIVE !== '1') throw new Error('STRIPE_SECRET_KEY is a live key; set ALLOW_LIVE=1 to take real payments (use a test key until you have tried a purchase)');
  if (!/^whsec_[A-Za-z0-9]+$/.test(env.STRIPE_WEBHOOK_SECRET)) throw new Error('STRIPE_WEBHOOK_SECRET is not a Stripe webhook signing secret (whsec_...)');
  if (!/^price_[A-Za-z0-9]+$/.test(env.STRIPE_PRICE_FOUNDING)) throw new Error('STRIPE_PRICE_FOUNDING is not a Stripe price id (price_...)');

  let base;
  try { base = new URL(env.JOIN_BASE_URL); } catch { throw new Error('JOIN_BASE_URL must be a web address'); }
  const local = ['localhost', '127.0.0.1'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(local && base.protocol === 'http:')) throw new Error('JOIN_BASE_URL must be https');
  for (const name of ['JOIN_TERMS_URL', 'JOIN_REFUND_URL', 'JOIN_PRIVACY_URL']) {
    if (!isHttps(env[name])) throw new Error(`${name} must be an https address`);
  }

  if (env.JOIN_TRACKER_URL && !isHttps(env.JOIN_TRACKER_URL)) throw new Error('JOIN_TRACKER_URL must be an https address');

  return {
    trackerUrl: env.JOIN_TRACKER_URL ?? null,
    secretKey, webhookSecret: env.STRIPE_WEBHOOK_SECRET, priceId: env.STRIPE_PRICE_FOUNDING, live,
    baseUrl: base.origin, joinHost: base.host,
    termsUrl: env.JOIN_TERMS_URL, refundUrl: env.JOIN_REFUND_URL, privacyUrl: env.JOIN_PRIVACY_URL,
    apiBase: 'https://api.stripe.com',
  };
}

async function stripeRequest(config, method, path, form, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${config.apiBase}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.secretKey}`, ...(form && { 'content-type': 'application/x-www-form-urlencoded' }) },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new StripeError(`could not reach Stripe (${error.name})`, 502);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new StripeError(`Stripe returned ${response.status}${data.error?.type ? `: ${data.error.type}` : ''}`, response.status); // never the message or the key
  return data;
}

// Starts a Checkout for the membership and returns the address to send the buyer to. The price comes from Stripe (by
// id), never from the request.
export async function createCheckoutSession(config, fetchImpl = fetch) {
  const session = await stripeRequest(config, 'POST', '/v1/checkout/sessions', {
    mode: 'payment',
    'line_items[0][price]': config.priceId,
    'line_items[0][quantity]': '1',
    success_url: `${config.baseUrl}/join/thanks`,
    cancel_url: `${config.baseUrl}/join`,
    'metadata[product]': PRODUCT,
  }, fetchImpl);
  if (typeof session.url !== 'string' || !isHttps(session.url)) throw new StripeError('Stripe did not return a checkout address', 502);
  return session.url;
}

// What the page shows as the price: read from Stripe so it can never disagree with what is charged.
export async function fetchOffer(config, fetchImpl = fetch) {
  const price = await stripeRequest(config, 'GET', `/v1/prices/${encodeURIComponent(config.priceId)}`, null, fetchImpl);
  if (!price.active || price.type !== 'one_time' || !Number.isInteger(price.unit_amount) || price.unit_amount <= 0 || typeof price.currency !== 'string') {
    throw new StripeError('the configured price is not an active one-time price', 502);
  }
  return { amount: price.unit_amount, currency: price.currency };
}

// Checks a webhook the way Stripe documents: the header carries a timestamp and one or more signatures; each is an
// HMAC-SHA256 of "<timestamp>.<raw body>" with the endpoint's signing secret. Returns the event, or throws.
export function verifyWebhook(rawBody, signatureHeader, secret, { now = Date.now() } = {}) {
  if (typeof signatureHeader !== 'string' || !Buffer.isBuffer(rawBody)) throw new StripeError('missing signature', 400);
  let timestamp = null;
  const signatures = [];
  for (const part of signatureHeader.split(',')) {
    const [key, value] = part.trim().split('=');
    if (key === 't') timestamp = value;
    else if (key === 'v1' && value) signatures.push(value);
  }
  if (!/^\d+$/.test(timestamp ?? '') || !signatures.length) throw new StripeError('malformed signature header', 400);
  if (Math.abs(now / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) throw new StripeError('signature timestamp outside the tolerance', 400); // stops replays

  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  const valid = signatures.some((hex) => {
    const given = Buffer.from(hex, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!valid) throw new StripeError('signature does not match', 400);
  try { return JSON.parse(rawBody.toString('utf8')); } catch { throw new StripeError('body is not JSON', 400); }
}
