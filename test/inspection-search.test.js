import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createApp } from '../server.js';
import { parseSearch, buildUrl, shape, createSearcher, exportAll, toCsv, SearchError, PAGE_SIZE, EXPORT_MAX } from '../inspection-search.js';
import { RateLimiter } from '../auth.js';

const params = (o) => new URLSearchParams(o);
const row = (n, extra = {}) => ({
  inspection_id: String(1000 + n), insp_date: '20260105', insp_start_time: '0808', location_desc: 'FORT COLLINS POE NB',
  insp_level_id: '3', viol_total: '2', oos_total: '1', vehicle_oos_total: '1', driver_oos_total: '0', hazmat_oos_total: '0',
  insp_carrier_name: 'DUCKS TRUCKING', insp_carrier_city: 'DENVER', insp_carrier_state: 'CO', dot_number: '3380514', ...extra,
});

test('parseSearch normalises a good search', () => {
  assert.deepEqual(parseSearch(params({ q: '  fort   collins ', from: '2026-01-01', to: '2026-01-31', offset: '50' })),
    { q: 'FORT COLLINS', from: '2026-01-01', to: '2026-01-31', levels: '', offset: 50 });
  assert.deepEqual(parseSearch(params({ from: '2026-01-01' })), { q: '', from: '2026-01-01', to: '', levels: '', offset: 0 });
});

test('parseSearch refuses anything that is not a plain, bounded search', () => {
  const bad = [
    {}, { q: 'a' }, { q: 'x'.repeat(41) }, { q: "a%b" }, { q: 'a_b' }, { q: 'a;b' }, { q: 'a"b' }, { q: 'a\\b' },
    { q: 'ok', from: '2026-02-30' }, { q: 'ok', from: '1999-12-31' }, { q: 'ok', to: 'yesterday' },
    { q: 'ok', from: '2026-02-01', to: '2026-01-01' },
    { q: 'ok', levels: '6' }, { q: 'ok', levels: '0' }, { q: 'ok', levels: '1,' }, { q: 'ok', levels: '1;2' }, { q: 'ok', levels: "1'" }, { q: 'ok', levels: '1,2,3,4,5,1' }, { q: 'ok', offset: '-50' }, { q: 'ok', offset: '25' }, { q: 'ok', offset: '1050' }, { q: 'ok', offset: '1e2' }, { q: 'ok', offset: 'x' },
  ];
  for (const b of bad) assert.throws(() => parseSearch(params(b)), SearchError, JSON.stringify(b));
});

test('the query always goes to the one fixed dataset with the fixed filters, and quotes are escaped', () => {
  const url = buildUrl(parseSearch(params({ q: "o'brien & sons", from: '2026-01-01', to: '2026-01-31', offset: '50' })));
  assert.equal(`${url.origin}${url.pathname}`, 'https://data.transportation.gov/resource/fx4q-ay7w.json');
  const where = url.searchParams.get('$where');
  assert.ok(where.startsWith("report_state='CO' AND insp_facility='F' AND "));
  assert.ok(where.includes("like '%O''BRIEN & SONS%'"));
  assert.ok(where.includes("insp_date >= '20260101'") && where.includes("insp_date <= '20260131'"));
  assert.equal(url.searchParams.get('$limit'), String(PAGE_SIZE + 1));
  assert.equal(url.searchParams.get('$offset'), '50');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['$limit', '$offset', '$order', '$select', '$where']);
});

test('shape keeps only what the list needs and survives odd rows', () => {
  const r = shape(row(1));
  assert.deepEqual(r, {
    id: '1001', date: '2026-01-05', time: '08:08', place: 'FORT COLLINS POE NB', level: '3', levelName: 'Driver / credentials',
    violations: 2, oos: { total: 1, vehicle: 1, driver: 0, hazmat: 0 }, carrier: 'DUCKS TRUCKING', city: 'DENVER', state: 'CO', dot: '3380514',
  });
  const odd = shape({ insp_date: 'x', viol_total: '-3', insp_level_id: '9', extra_field: 'secret' });
  assert.equal(odd.date, null);
  assert.equal(odd.violations, 0);
  assert.equal(odd.levelName, 'Other');
  assert.equal('extra_field' in odd, false);
});

test('the searcher pages, caches, expires the cache and hides upstream failures', async () => {
  let calls = 0;
  let now = 1_000;
  const rows = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => row(i));
  const searcher = createSearcher({ fetchImpl: async () => { calls++; return { ok: true, json: async () => rows }; }, now: () => now });
  const search = parseSearch(params({ q: 'limon' }));
  const a = await searcher(search);
  assert.equal(a.results.length, PAGE_SIZE);
  assert.equal(a.hasMore, true);
  await searcher(search);
  assert.equal(calls, 1);                                  // second one came from the cache
  now += 11 * 60_000;
  await searcher(search);
  assert.equal(calls, 2);                                  // cache expired

  const failing = [
    async () => { throw new Error('secret upstream detail'); },
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => ({ not: 'an array' }) }),
  ];
  for (const fetchImpl of failing) {
    await assert.rejects(createSearcher({ fetchImpl })(search), (e) => e.message === 'upstream');
  }
});

async function start(t, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-search-'));
  const app = await createApp({ statusFile: join(dir, 'status.json'), subscriptionsFile: join(dir, 'subs.json'), membersFile: join(dir, 'members.json'), ...opts });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(async () => { app.closeAllConnections(); await new Promise((r) => app.close(r)); await rm(dir, { recursive: true, force: true }); });
  return `http://127.0.0.1:${app.address().port}`;
}

test('GET /api/inspection-search: results, validation, method, failure and rate limit', async (t) => {
  const seen = [];
  const base = await start(t, {
    searchImpl: async (s) => { seen.push(s); if (s.q === 'BOOM') throw new Error('upstream: http://secret'); return { results: [shape(row(1))], hasMore: false, offset: s.offset, pageSize: PAGE_SIZE }; },
    searchLimiter: new RateLimiter({ max: 5, windowMs: 60_000 }),
  });
  const ok = await fetch(`${base}/api/inspection-search?q=collins&from=2026-01-01`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal((await ok.json()).results[0].place, 'FORT COLLINS POE NB');
  assert.deepEqual(seen[0], { q: 'COLLINS', from: '2026-01-01', to: '', levels: '', offset: 0 });

  assert.equal((await fetch(`${base}/api/inspection-search`)).status, 400);
  assert.equal((await fetch(`${base}/api/inspection-search?q=a%25b`)).status, 400);
  assert.equal((await fetch(`${base}/api/inspection-search?q=ok`, { method: 'POST' })).status, 405);
  const boom = await fetch(`${base}/api/inspection-search?q=boom`);
  assert.equal(boom.status, 502);
  assert.doesNotMatch(await boom.text(), /secret|upstream:/);
  assert.equal(seen.length, 2);                              // only valid searches count against the limit and reach the searcher

  assert.equal((await fetch(`${base}/api/inspection-search?q=again`)).status, 200);   // 3rd valid search
  assert.equal((await fetch(`${base}/api/inspection-search?q=again2`)).status, 200);  // 4th
  assert.equal((await fetch(`${base}/api/inspection-search?q=again3`)).status, 200);  // 5th: the limit is 5 a minute
  const limited = await fetch(`${base}/api/inspection-search?q=again4`);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('the page wires the search in: script loaded after app.js, cached by the service worker', async () => {
  const read = (f) => readFile(new URL(`../public/${f}`, import.meta.url), 'utf8');
  const html = await read('index.html');
  assert.ok(html.includes('src="search.js"') && html.indexOf('src="search.js"') > html.indexOf('src="app.js"'));
  for (const id of ['search-open', 's-q', 's-from', 's-to', 's-more', 's-results', 's-status', 's-go', 's-close', 's-csv', 'search-form', 'class="s-level"']) {
    assert.ok(html.includes(id.startsWith('class') ? id : `id="${id}"`), id);
  }
  assert.match(await read('sw.js'), /'\/search\.js'/);
  assert.match(await read('search.js'), /\/api\/inspection-search\.csv/);
});

test('level filter: normalised, all five means none, and it reaches the query as quoted values', () => {
  assert.equal(parseSearch(params({ q: 'ok', levels: '3,1,3' })).levels, '1,3');
  assert.equal(parseSearch(params({ q: 'ok', levels: '5,4,3,2,1' })).levels, '');
  assert.equal(parseSearch(params({ q: 'ok' })).levels, '');
  const where = buildUrl(parseSearch(params({ q: 'ok', levels: '3,1' }))).searchParams.get('$where');
  assert.ok(where.endsWith("AND insp_level_id in('1','3')"), where);
  assert.ok(!buildUrl(parseSearch(params({ q: 'ok' }))).searchParams.get('$where').includes('insp_level_id'));
});

test('a different level filter is a different cache entry', async () => {
  let calls = 0;
  const searcher = createSearcher({ fetchImpl: async () => { calls++; return { ok: true, json: async () => [] }; } });
  await searcher(parseSearch(params({ q: 'ok', levels: '1' })));
  await searcher(parseSearch(params({ q: 'ok', levels: '3' })));
  await searcher(parseSearch(params({ q: 'ok', levels: '1' })));
  assert.equal(calls, 2);
});
