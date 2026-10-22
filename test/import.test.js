import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { parseCsv } from '../adapters/file.js';

async function start(t, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-'));
  const server = await createApp({ statusFile: join(dir, 'status.json'), ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true }); });
  return { base };
}
const post = (base, body, headers = {}) =>
  fetch(`${base}/api/import`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const get = async (base, id) => (await fetch(`${base}/api/stations/${id}`)).json();

test('imports by id or name, tags the source, normalizes status', async (t) => {
  const { base } = await start(t);
  const r = await (await post(base, { source: 'csp', records: [
    { station: 'limon', status: 'OPEN' },
    { station: 'Fort Collins', status: 'Closed', note: 'Scale down' },
  ] })).json();
  assert.deepEqual(r.updated.sort(), ['fort-collins', 'limon']);
  const s = await get(base, 'fort-collins');
  assert.equal(s.status, 'closed');
  assert.equal(s.source, 'csp');
});

test('skips unknown, planned, invalid and future-dated records without failing the batch', async (t) => {
  const { base } = await start(t);
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const r = await (await post(base, { source: 'csp', records: [
    { station: 'nowhere', status: 'open' },
    { station: 'platteville', status: 'open' },
    { station: 'limon', status: 'maybe' },
    { station: 'limon', status: 'open', updatedAt: 'garbage' },
    { station: 'limon', status: 'open', updatedAt: future },
    { station: 'cortez', status: 'open' },
  ] })).json();
  assert.deepEqual(r.updated, ['cortez']);
  assert.deepEqual(r.skipped.map((s) => s.reason), [
    'unknown station', 'station is not open yet', 'unrecognized status "maybe"', 'invalid updatedAt', 'updatedAt is in the future',
  ]);
});

test('re-importing the same data is a no-op and does not grow history', async (t) => {
  const { base } = await start(t);
  const body = { source: 'csp', records: [{ station: 'limon', status: 'open', note: 'ok' }] };
  await post(base, body);
  const r = await (await post(base, body)).json();
  assert.deepEqual(r.unchanged, ['limon']);
  assert.equal((await (await fetch(`${base}/api/stations/limon/history`)).json()).length, 1);
});

test('does not overwrite a newer status with an older record', async (t) => {
  const { base } = await start(t);
  await post(base, { source: 'csp', records: [{ station: 'limon', status: 'closed' }] });
  const r = await (await post(base, { source: 'csp', records: [{ station: 'limon', status: 'open', updatedAt: '2020-01-01T00:00:00Z' }] })).json();
  assert.equal(r.skipped[0].reason, 'older than current status');
  assert.equal((await get(base, 'limon')).status, 'closed');
});

test('import validates source/records and honors the token', async (t) => {
  const { base } = await start(t, { token: 't' });
  assert.equal((await post(base, { source: 'csp', records: [] })).status, 401);
  const auth = { authorization: 'Bearer t' };
  assert.equal((await post(base, { source: 'bad source!', records: [] }, auth)).status, 400);
  assert.equal((await post(base, { source: 'csp', records: 'nope' }, auth)).status, 400);
  assert.equal((await post(base, { source: 'csp', records: [] }, auth)).status, 200);
});

test('manual PUT cannot spoof source or updatedAt', async (t) => {
  const { base } = await start(t);
  await fetch(`${base}/api/stations/limon/status`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'open', source: 'csp', updatedAt: '2001-01-01T00:00:00Z' }) });
  const s = await get(base, 'limon');
  assert.equal(s.source, 'manual');
  assert.ok(s.updatedAt > '2020');
});

test('parseCsv handles quotes, commas, CRLF and blank lines', () => {
  const rows = parseCsv('station,status,note\r\nlimon,open,"Wait, ~10 min"\r\n\r\ncortez,closed,"say ""hi"""\r\n');
  assert.deepEqual(rows, [
    { station: 'limon', status: 'open', note: 'Wait, ~10 min' },
    { station: 'cortez', status: 'closed', note: 'say "hi"' },
  ]);
});
