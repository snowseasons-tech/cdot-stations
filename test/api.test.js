import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { groupStations } from '../scripts/sync-stations.js';

async function start(opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-'));
  const server = await createApp({ statusFile: join(dir, 'status.json'), ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, stop: async () => { server.close(); await rm(dir, { recursive: true }); } };
}
const put = (base, id, body, headers = {}) =>
  fetch(`${base}/api/stations/${id}/status`, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('lists stations, defaulting to unknown', async () => {
  const { base, stop } = await start();
  const { stations } = await (await fetch(`${base}/api/stations`)).json();
  assert.equal(stations.length, 10);
  assert.ok(stations.every((s) => s.status === 'unknown'));
  await stop();
});

test('status update persists and appears in history', async () => {
  const { base, stop } = await start();
  const r = await put(base, 'limon', { status: 'closed', note: 'Scale down' });
  assert.equal(r.status, 200);
  const s = await (await fetch(`${base}/api/stations/limon`)).json();
  assert.equal(s.status, 'closed');
  const h = await (await fetch(`${base}/api/stations/limon/history`)).json();
  assert.equal(h.length, 1);
  await stop();
});

test('rejects bad input, unknown and planned stations', async () => {
  const { base, stop } = await start();
  assert.equal((await put(base, 'limon', { status: 'maybe' })).status, 400);
  assert.equal((await put(base, 'limon', { status: 'open', note: 'x'.repeat(281) })).status, 400);
  assert.equal((await put(base, 'nowhere', { status: 'open' })).status, 404);
  assert.equal((await put(base, 'platteville', { status: 'open' })).status, 409);
  await stop();
});

test('token is enforced when configured', async () => {
  const { base, stop } = await start({ token: 'secret' });
  assert.equal((await put(base, 'limon', { status: 'open' })).status, 401);
  assert.equal((await put(base, 'limon', { status: 'open' }, { authorization: 'Bearer secret' })).status, 200);
  await stop();
});

test('does not serve files outside public/', async () => {
  const { base, stop } = await start();
  const r = await fetch(`${base}/..%2fserver.js`);
  assert.ok([403, 404].includes(r.status));
  assert.equal((await fetch(`${base}/`)).status, 200);
  await stop();
});

test('groupStations merges directions and flags planned sites', () => {
  const f = (name, dir, phone = '1') => ({ geometry: { coordinates: [-105, 39] }, properties: { Port_Name: name, Direction: dir, Phone: phone, Highway: 'I-70', Mile_Post: '1' } });
  const out = groupStations([f('Dumont', 'EB'), f('Dumont', 'WB'), f('Platteville Future SIte', 'Center', 'Not Open Yet')]);
  assert.equal(out.length, 2);
  assert.equal(out[0].locations.length, 2);
  assert.equal(out[1].id, 'platteville');
  assert.equal(out[1].planned, true);
});
