import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { importStatuses } from './importer.js';
import { summarize } from './inspections.js';
import { summarizeLocations, parseLevels, PERIODS } from './inspection-locations.js';
import { FailureLimiter, RateLimiter, tokenMatches } from './auth.js';
import { Members } from './members.js';
import { loadStripeConfig, createCheckoutSession, fetchOffer, describeOffer, termOf, verifyWebhook, StripeError, PRODUCT } from './stripe.js';
import { Subscriptions, LimitReached, createNotifier, createWebPushSender, loadPushConfig, validateRequest, isPushEndpoint } from './push.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');

// Served on every response. HSTS is deliberately not here: add it at the HTTPS-terminating proxy.
const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'self' https://unpkg.com",
    "style-src 'self' https://unpkg.com",
    "style-src-attr 'unsafe-inline'", // Leaflet and the map pins set inline style attributes
    "img-src 'self' data: https://tile.openstreetmap.org https://unpkg.com",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'", // the service worker (public/sw.js)
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin', // OpenStreetMap's tile servers require a Referer
  'permissions-policy': 'geolocation=(), camera=(), microphone=(), payment=()',
  'cross-origin-opener-policy': 'same-origin',
};

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
};

export async function createApp({ stationsFile = join(ROOT, 'data/stations.json'), inspectionsFile = join(ROOT, 'data/inspections.json'), locationsFile = join(ROOT, 'data/inspection-locations.json'), statusFile = process.env.STATUS_FILE ?? join(ROOT, 'data/status.json'), token = process.env.STATUS_TOKEN, trustProxy = process.env.TRUST_PROXY === '1', limiter = new FailureLimiter(),
  subscriptionsFile = process.env.SUBSCRIPTIONS_FILE ?? join(ROOT, 'data/subscriptions.json'),
  membersFile = process.env.MEMBERS_FILE ?? join(ROOT, 'data/members.json'),
  stripeConfig = loadStripeConfig(), stripeFetch = fetch, joinLimiter = new RateLimiter({ max: 10, windowMs: 60_000 }),
  pushConfig = loadPushConfig(), pushSender, pushLimiter = new RateLimiter({ max: 30, windowMs: 60_000 }) } = {}) {
  const { stations, fetchedAt } = JSON.parse(await readFile(stationsFile, 'utf8'));
  const inspections = await readFile(inspectionsFile, 'utf8').then(JSON.parse, (e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  const locations = await readFile(locationsFile, 'utf8').then(JSON.parse, (e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  // Push notifications are on only when the VAPID keys are configured; otherwise the /api/push routes answer 503.
  const subscriptions = new Subscriptions(subscriptionsFile);
  await subscriptions.load();
  const notifier = pushConfig
    ? createNotifier({ subscriptions, stations, sender: pushSender ?? await createWebPushSender(pushConfig) })
    : null;
  const store = new Store(statusFile, { onChange: (event) => notifier?.notify(event) }); // fire and forget: never delays a save
  await store.load();
  const members = new Members(membersFile);
  await members.load();
  const find = (id) => stations.find((s) => s.id === id);
  const view = (s) => ({ ...s, ...store.get(s.id), inspections: summarize(inspections, s.id) });

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  // Behind a reverse proxy every connection comes from the proxy, so the client is taken from X-Real-IP,
  // but only when TRUST_PROXY=1 (otherwise a caller could spoof it to dodge the lockout).
  const clientOf = (req) => (trustProxy && req.headers['x-real-ip']) || req.socket.remoteAddress || 'unknown';

  // Returns true if the caller may write; otherwise sends the 401/429 and returns false.
  const authorize = (req, res) => {
    if (!token) return true;
    const client = clientOf(req);
    const wait = limiter.retryAfter(client);
    if (wait) {
      res.setHeader('retry-after', wait);
      json(res, 429, { error: 'too many failed attempts; try again later' });
      return false;
    }
    if (tokenMatches(req.headers.authorization, token)) return true;
    limiter.fail(client);
    json(res, 401, { error: 'unauthorized' });
    return false;
  };

  const readBody = async (req, limit = 10_000) => {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      if ((size += c.length) > limit) throw new RangeError('body too large');
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  };

  // Stripe signs the exact bytes it sends, so the webhook needs the body unparsed.
  const readRaw = async (req, limit) => {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      if ((size += c.length) > limit) throw new RangeError('body too large');
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  };

  // The price shown on the sales page is read from Stripe (so it can't differ from what is charged) and kept for 10 minutes.
  let offerCache = null;
  const getOffer = async () => {
    if (!offerCache || Date.now() - offerCache.at > 600_000) offerCache = { at: Date.now(), value: await fetchOffer(stripeConfig, stripeFetch) };
    return offerCache.value;
  };
  const FULFIL_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

  const server = createServer(async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
      const { pathname } = new URL(req.url, 'http://x');

      // ---- selling memberships (off unless Stripe is configured) ----
      const selling = Boolean(stripeConfig);
      const salesPath = pathname === '/join' || pathname.startsWith('/join/') || ['/api/offer', '/api/checkout', '/api/stripe-webhook'].includes(pathname);
      // The public sales hostname answers only the sales pages and Stripe's webhook; the tracker's data is never served on it.
      if (selling && (req.headers.host ?? '').toLowerCase() === stripeConfig.joinHost) {
        if (pathname === '/') { res.writeHead(302, { location: '/join' }); return res.end(); }
        if (!salesPath) return json(res, 404, { error: 'not found' });
      }
      if (salesPath && !selling) return json(res, 404, { error: 'not found' });

      if (pathname === '/api/offer') {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
        try {
          return json(res, 200, { ...describeOffer(stripeConfig, await getOffer()), termsUrl: stripeConfig.termsUrl, refundUrl: stripeConfig.refundUrl, privacyUrl: stripeConfig.privacyUrl, trackerUrl: stripeConfig.trackerUrl });
        } catch (e) {
          console.error(`offer unavailable: ${e.message}`);
          return json(res, 503, { error: 'checkout is unavailable right now' });
        }
      }

      if (pathname === '/api/checkout') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        // Same protections as the push endpoints: JSON only (a cross-site page can't send that without a CORS preflight,
        // which is never granted), nothing the browser marks cross-site, and a per-client rate limit.
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: 'content-type must be application/json' });
        if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'cross-site requests are not allowed' });
        const wait = joinLimiter.allow(clientOf(req));
        if (wait) { res.setHeader('retry-after', wait); return json(res, 429, { error: 'too many requests; try again later' }); }
        const body = await readBody(req, 1_000);
        if (body.agreed !== true) return json(res, 400, { error: 'you need to agree to the terms first' });
        try {
          return json(res, 200, { url: await createCheckoutSession(stripeConfig, stripeFetch) });
        } catch (e) {
          console.error(`checkout failed: ${e.message}`);
          return json(res, 502, { error: 'could not start checkout; please try again' });
        }
      }

      if (pathname === '/api/stripe-webhook') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        let event;
        try {
          event = verifyWebhook(await readRaw(req, 262_144), req.headers['stripe-signature'], stripeConfig.webhookSecret);
        } catch (e) {
          if (e instanceof StripeError || e instanceof RangeError) return json(res, 400, { error: 'invalid webhook' });
          throw e;
        }
        const session = event.data?.object;
        if (FULFIL_EVENTS.has(event.type) && session?.mode === 'payment' && session.payment_status === 'paid' && session.metadata?.product === PRODUCT && typeof session.id === 'string') {
          try {
            const term = termOf(session);
            await members.recordPurchase({
              months: term.months, termKnown: term.known,
              sessionId: session.id, eventId: event.id, email: session.customer_details?.email ?? session.customer_email,
              name: session.customer_details?.name, amount: session.amount_total, currency: session.currency,
              paidAt: new Date((Number(session.created) || Date.now() / 1000) * 1000).toISOString(),
            });
          } catch (e) {
            console.error(`could not record a paid session: ${e.message}`);
            return json(res, 500, { error: 'internal error' }); // Stripe retries on a non-2xx answer
          }
        }
        return json(res, 200, { received: true }); // events we don't act on are acknowledged too, so Stripe stops resending them
      }

      // The people who have bought, for whoever adds them to the sign-in list. Write-token only.
      if (pathname === '/api/members') {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
        if (!authorize(req, res)) return;
        const q = new URL(req.url, 'http://x').searchParams;
        return json(res, 200, { members: q.get('expired') === '1' ? members.expired() : q.get('pending') === '1' ? members.pending() : members.list() });
      }
      const granted = pathname.match(/^\/api\/members\/(cs_[A-Za-z0-9_]+)\/(granted|removed)$/);
      if (granted) {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        if (!authorize(req, res)) return;
        const member = await (granted[2] === 'granted' ? members.markGranted(granted[1]) : members.markRemoved(granted[1]));
        return member ? json(res, 200, member) : json(res, 404, { error: 'no such member' });
      }
      const m = pathname.match(/^\/api\/stations(?:\/([a-z0-9-]+)(\/history|\/status|\/inspections)?)?$/);

      if (m && req.method === 'GET' && !m[1]) return json(res, 200, { fetchedAt, stations: stations.map(view) });
      if (m?.[1]) {
        const s = find(m[1]);
        if (!s) return json(res, 404, { error: 'station not found' });
        if (req.method === 'GET' && !m[2]) return json(res, 200, view(s));
        if (req.method === 'GET' && m[2] === '/history') return json(res, 200, store.history(s.id));
        if (req.method === 'GET' && m[2] === '/inspections') {
          const months = Number(new URL(req.url, 'http://x').searchParams.get('months') ?? 12);
          if (!Number.isInteger(months) || months < 1 || months > 36) return json(res, 400, { error: 'months must be an integer from 1 to 36' });
          return json(res, 200, summarize(inspections, s.id, months));
        }
        if (req.method === 'PUT' && m[2] === '/status') {
          if (!authorize(req, res)) return;
          if (s.planned) return json(res, 409, { error: 'station is not open yet' });
          const { status, note } = await readBody(req);
          return json(res, 200, await store.set(s.id, { status, note }));
        }
        return json(res, 405, { error: 'method not allowed' });
      }
      if (m) return json(res, 405, { error: 'method not allowed' });

      if (pathname.startsWith('/api/push/')) {
        if (!notifier) return json(res, 503, { error: 'push notifications are not configured' });
        if (pathname === '/api/push/key' && req.method === 'GET') return json(res, 200, { publicKey: pushConfig.publicKey });
        if (!['/api/push/subscribe', '/api/push/following', '/api/push/unsubscribe'].includes(pathname)) return json(res, 404, { error: 'not found' });
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        // These POSTs need no token (the site is behind the team sign-in), so make them hard to forge from another
        // website: JSON only (a cross-site page can't send that without a CORS preflight, which is never granted),
        // and refuse anything the browser marks as cross-site.
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: 'content-type must be application/json' });
        if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'cross-site requests are not allowed' });
        const wait = pushLimiter.allow(clientOf(req));
        if (wait) { res.setHeader('retry-after', wait); return json(res, 429, { error: 'too many requests; try again later' }); }
        const body = await readBody(req, 4_096);
        if (pathname === '/api/push/subscribe') {
          const { subscription, stations: followed } = validateRequest(body, new Set(stations.map((s) => s.id)));
          return json(res, 200, await subscriptions.set(subscription, followed));
        }
        if (!isPushEndpoint(body.endpoint)) return json(res, 400, { error: 'endpoint must be a push service address' });
        if (pathname === '/api/push/following') return json(res, 200, { stations: subscriptions.following(body.endpoint) });
        return json(res, 200, await subscriptions.remove(body.endpoint));
      }

      if (pathname === '/api/inspection-locations') {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
        const q = new URL(req.url, 'http://x').searchParams;
        const levels = parseLevels(q.get('levels'));
        const period = q.get('period') ?? '12m';
        if (!levels) return json(res, 400, { error: 'levels must be a comma-separated list of 1-5' });
        if (!PERIODS.includes(period)) return json(res, 400, { error: `period must be one of ${PERIODS.join(', ')}` });
        return json(res, 200, summarizeLocations(locations, { levels, period }));
      }

      if (pathname === '/api/import') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        if (!authorize(req, res)) return;
        const { source, records } = await readBody(req, 500_000);
        if (!/^[a-z0-9_-]{1,40}$/i.test(source ?? '')) return json(res, 400, { error: 'source must be 1-40 letters, digits, - or _' });
        if (!Array.isArray(records) || records.length > 500) return json(res, 400, { error: 'records must be an array of up to 500 items' });
        return json(res, 200, await importStatuses(store, stations, records, { source }));
      }

      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      const pages = { '/': '/index.html', '/join': '/join/index.html', '/join/thanks': '/join/thanks.html' };
      const rel = normalize(pages[pathname] ?? pathname);
      const file = join(PUBLIC, rel);
      if (!file.startsWith(PUBLIC + '/')) return json(res, 403, { error: 'forbidden' });
      const body = await readFile(file).catch(() => null);
      if (!body) return json(res, 404, { error: 'not found' });
      // Static files are never cached without checking: a copy kept by a browser or by Cloudflare would keep serving
      // an old version of the app after a deploy (phones were running a stale app.js for hours). `no-cache` means
      // "re-check every time", and the ETag makes that check cheap (304 when unchanged); CDN-Cache-Control tells
      // Cloudflare not to store its own copy at all.
      const etag = `"${createHash('sha1').update(body).digest('base64url').slice(0, 22)}"`;
      const caching = { 'cache-control': 'no-cache', 'cdn-cache-control': 'no-store', etag };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, caching);
        return res.end();
      }
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', ...caching });
      res.end(body);
    } catch (e) {
      if (e instanceof LimitReached) return json(res, 503, { error: e.message });
      json(res, e instanceof RangeError || e instanceof SyntaxError ? 400 : 500, { error: e.message });
    }
  });
  server.push = { subscriptions, notifier }; // exposed for tests
  server.members = members;
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (!loopback && !process.env.STATUS_TOKEN && process.env.ALLOW_OPEN_WRITES !== '1') {
    console.error(`Refusing to listen on ${host} without STATUS_TOKEN: anyone could change station status. Set STATUS_TOKEN (or ALLOW_OPEN_WRITES=1 to override).`);
    process.exit(1);
  }
  (await createApp()).listen(port, host, () => console.log(`CDOT stations tracker on http://${host}:${port}`));
}
