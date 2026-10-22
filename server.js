import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { importStatuses } from './importer.js';
import { summarize } from './inspections.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

export async function createApp({ stationsFile = join(ROOT, 'data/stations.json'), inspectionsFile = join(ROOT, 'data/inspections.json'), statusFile = join(ROOT, 'data/status.json'), token = process.env.STATUS_TOKEN } = {}) {
  const { stations, fetchedAt } = JSON.parse(await readFile(stationsFile, 'utf8'));
  const inspections = await readFile(inspectionsFile, 'utf8').then(JSON.parse, (e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  const store = new Store(statusFile);
  await store.load();
  const find = (id) => stations.find((s) => s.id === id);
  const view = (s) => ({ ...s, ...store.get(s.id), inspections: summarize(inspections, s.id) });

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const authorized = (req) => !token || req.headers.authorization === `Bearer ${token}`;

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
          if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
          if (s.planned) return json(res, 409, { error: 'station is not open yet' });
          const { status, note } = await readBody(req);
          return json(res, 200, await store.set(s.id, { status, note }));
        }
        return json(res, 405, { error: 'method not allowed' });
      }
      if (m) return json(res, 405, { error: 'method not allowed' });

      if (pathname === '/api/import') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
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
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch (e) {
      json(res, e instanceof RangeError || e instanceof SyntaxError ? 400 : 500, { error: e.message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  (await createApp()).listen(port, host, () => console.log(`CDOT stations tracker on http://${host}:${port}`));
}
