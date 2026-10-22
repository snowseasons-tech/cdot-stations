import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { importStatuses } from './importer.js';
import { summarize } from './inspections.js';
import { summarizeLocations, parseLevels, PERIODS } from './inspection-locations.js';
import { FailureLimiter, tokenMatches } from './auth.js';

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

export async function createApp({ stationsFile = join(ROOT, 'data/stations.json'), inspectionsFile = join(ROOT, 'data/inspections.json'), locationsFile = join(ROOT, 'data/inspection-locations.json'), statusFile = process.env.STATUS_FILE ?? join(ROOT, 'data/status.json'), token = process.env.STATUS_TOKEN, trustProxy = process.env.TRUST_PROXY === '1', limiter = new FailureLimiter() } = {}) {
  const { stations, fetchedAt } = JSON.parse(await readFile(stationsFile, 'utf8'));
  const inspections = await readFile(inspectionsFile, 'utf8').then(JSON.parse, (e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  const locations = await readFile(locationsFile, 'utf8').then(JSON.parse, (e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  const store = new Store(statusFile);
  await store.load();
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

  return createServer(async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
      const { pathname } = new URL(req.url, 'http://x');
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
      const rel = normalize(pathname === '/' ? '/index.html' : pathname);
      const file = join(PUBLIC, rel);
      if (!file.startsWith(PUBLIC + '/')) return json(res, 403, { error: 'forbidden' });
      const body = await readFile(file).catch(() => null);
      if (!body) return json(res, 404, { error: 'not found' });
      // The service worker script must always be re-checked so an update reaches installed apps promptly.
      const extra = rel === '/sw.js' ? { 'cache-control': 'no-cache' } : {};
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', ...extra });
      res.end(body);
    } catch (e) {
      json(res, e instanceof RangeError || e instanceof SyntaxError ? 400 : 500, { error: e.message });
    }
  });
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
