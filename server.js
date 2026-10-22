import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

export async function createApp({ stationsFile = join(ROOT, 'data/stations.json'), statusFile = join(ROOT, 'data/status.json'), token = process.env.STATUS_TOKEN } = {}) {
  const { stations, fetchedAt } = JSON.parse(await readFile(stationsFile, 'utf8'));
  const store = new Store(statusFile);
  await store.load();
  const find = (id) => stations.find((s) => s.id === id);
  const view = (s) => ({ ...s, ...store.get(s.id) });

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const readBody = async (req) => {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      if ((size += c.length) > 10_000) throw new RangeError('body too large');
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  };

  return createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://x');
      const m = pathname.match(/^\/api\/stations(?:\/([a-z0-9-]+)(\/history|\/status)?)?$/);

      if (m && req.method === 'GET' && !m[1]) return json(res, 200, { fetchedAt, stations: stations.map(view) });
      if (m?.[1]) {
        const s = find(m[1]);
        if (!s) return json(res, 404, { error: 'station not found' });
        if (req.method === 'GET' && !m[2]) return json(res, 200, view(s));
        if (req.method === 'GET' && m[2] === '/history') return json(res, 200, store.history(s.id));
        if (req.method === 'PUT' && m[2] === '/status') {
          if (token && req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'unauthorized' });
          if (s.planned) return json(res, 409, { error: 'station is not open yet' });
          return json(res, 200, await store.set(s.id, await readBody(req)));
        }
        return json(res, 405, { error: 'method not allowed' });
      }
      if (m) return json(res, 405, { error: 'method not allowed' });

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
