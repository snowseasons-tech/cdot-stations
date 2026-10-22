import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { groupStations } from '../scripts/sync-stations.js';

async function start(t, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-'));
  const server = await createApp({ statusFile: join(dir, 'status.json'), ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true }); });
  return { base };
}
const put = (base, id, body, headers = {}) =>
  fetch(`${base}/api/stations/${id}/status`, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('lists stations, defaulting to unknown', async (t) => {
  const { base } = await start(t);
  const { stations } = await (await fetch(`${base}/api/stations`)).json();
  assert.equal(stations.length, 10);
  assert.ok(stations.every((s) => s.status === 'unknown'));
});

test('status update persists and appears in history', async (t) => {
  const { base } = await start(t);
  const r = await put(base, 'limon', { status: 'closed', note: 'Scale down' });
  assert.equal(r.status, 200);
  const s = await (await fetch(`${base}/api/stations/limon`)).json();
  assert.equal(s.status, 'closed');
  const h = await (await fetch(`${base}/api/stations/limon/history`)).json();
  assert.equal(h.length, 1);
});

test('rejects bad input, unknown and planned stations', async (t) => {
  const { base } = await start(t);
  assert.equal((await put(base, 'limon', { status: 'maybe' })).status, 400);
  assert.equal((await put(base, 'limon', { status: 'open', note: 'x'.repeat(281) })).status, 400);
  assert.equal((await put(base, 'nowhere', { status: 'open' })).status, 404);
  assert.equal((await put(base, 'platteville', { status: 'open' })).status, 409);
});

test('token is enforced when configured', async (t) => {
  const { base } = await start(t, { token: 'secret' });
  assert.equal((await put(base, 'limon', { status: 'open' })).status, 401);
  assert.equal((await put(base, 'limon', { status: 'open' }, { authorization: 'Bearer secret' })).status, 200);
});

test('does not serve files outside public/', async (t) => {
  const { base } = await start(t);
  const r = await fetch(`${base}/..%2fserver.js`);
  assert.ok([403, 404].includes(r.status));
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test('groupStations merges directions and flags planned sites', () => {
  const f = (name, dir, phone = '1') => ({ geometry: { coordinates: [-105, 39] }, properties: { Port_Name: name, Direction: dir, Phone: phone, Highway: 'I-70', Mile_Post: '1' } });
  const out = groupStations([f('Dumont', 'EB'), f('Dumont', 'WB'), f('Platteville Future SIte', 'Center', 'Not Open Yet')]);
  assert.equal(out.length, 2);
  assert.equal(out[0].locations.length, 2);
  assert.equal(out[1].id, 'platteville');
  assert.equal(out[1].planned, true);
});

test('refuses to listen on a public address without a token', async () => {
  const { spawnSync } = await import('node:child_process');
  const run = (env) => spawnSync(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH, PORT: '0', ...env }, timeout: 1500, encoding: 'utf8' });
  const refused = run({ HOST: '0.0.0.0' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /STATUS_TOKEN/);
  const allowed = run({ HOST: '0.0.0.0', STATUS_TOKEN: 'x' });
  assert.notEqual(allowed.status, 1); // still running when the timeout killed it
});
