import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { centroid } from '../geo.js';

const stationsData = JSON.parse(await readFile(new URL('../data/stations.json', import.meta.url), 'utf8')).stations;
const limon = stationsData.find((s) => s.id === 'limon');
const WB = limon.locations.find((l) => l.direction === 'WB');
const EB = limon.locations.find((l) => l.direction === 'EB');
const cortez = stationsData.find((s) => s.id === 'cortez').locations[0]; // direction 'NB/SB', which contains a slash

async function start(t, { dir: existingDir, ...opts } = {}) {
  const dir = existingDir ?? await mkdtemp(join(tmpdir(), 'cdot-'));
  const server = await createApp({
    statusFile: join(dir, 'status.json'), subscriptionsFile: join(dir, 'subscriptions.json'), positionsFile: join(dir, 'positions.json'),
    token: 'secret', pushConfig: null, ...opts,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); server.close(); if (!existingDir) await rm(dir, { recursive: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const move = (id, direction, body, headers = { authorization: 'Bearer secret' }) =>
    fetch(`${base}/api/stations/${id}/locations/${encodeURIComponent(direction)}/position`, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const revert = (id, direction, headers = { authorization: 'Bearer secret' }) =>
    fetch(`${base}/api/stations/${id}/locations/${encodeURIComponent(direction)}/position`, { method: 'DELETE', headers });
  const station = async (id) => (await fetch(`${base}/api/stations/${id}`)).json();
  const portCircle = async () => (await (await fetch(`${base}/api/inspection-locations?levels=1,2,3,4,5&period=all`)).json()).locations.find((l) => l.id === 'port:limon');
  return { base, dir, server, move, revert, station, portCircle };
}
const nearWB = { lat: WB.lat + 0.004, lng: WB.lng - 0.003, note: 'moved to the new building' }; // a few hundred metres

test('nothing is moved to begin with, and every pin keeps its CDOT position', async (t) => {
  const { station } = await start(t);
  const s = await station('limon');
  for (const l of s.locations) { assert.equal(l.original, undefined); assert.equal(l.correction, undefined); }
  assert.equal(s.locations.find((l) => l.direction === 'WB').lat, WB.lat);
});

test('saving a position needs the write token', async (t) => {
  const { move, revert, station } = await start(t);
  assert.equal((await move('limon', 'WB', nearWB, {})).status, 401);
  assert.equal((await move('limon', 'WB', nearWB, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await revert('limon', 'WB', {})).status, 401);
  assert.equal((await station('limon')).locations.find((l) => l.direction === 'WB').lat, WB.lat); // nothing changed
});

test('a saved position replaces that one pin, and keeps CDOT\'s original and the reason', async (t) => {
  const { move, station, base } = await start(t);
  const r = await move('limon', 'WB', nearWB);
  assert.equal(r.status, 200);
  const saved = await r.json();
  assert.equal(saved.direction, 'WB');
  assert.deepEqual([saved.lat, saved.lng], [Math.round(nearWB.lat * 1e6) / 1e6, Math.round(nearWB.lng * 1e6) / 1e6]);
  assert.deepEqual(saved.original, { lat: WB.lat, lng: WB.lng });
  assert.equal(saved.correction.note, 'moved to the new building');
  assert.equal(saved.correction.source, 'manual');
  assert.equal(saved.correction.cdotAgrees, false);
  assert.ok(Date.parse(saved.correction.savedAt) > Date.now() - 5000);

  const s = await station('limon');
  assert.equal(s.locations.find((l) => l.direction === 'WB').lat, saved.lat);
  const east = s.locations.find((l) => l.direction === 'EB');
  assert.deepEqual([east.lat, east.lng, east.correction], [EB.lat, EB.lng, undefined]); // the other direction is untouched

  const list = (await (await fetch(`${base}/api/stations`)).json()).stations.find((x) => x.id === 'limon');
  assert.equal(list.locations.find((l) => l.direction === 'WB').lat, saved.lat); // the list endpoint agrees
});

test('a direction containing a slash works (URL-encoded)', async (t) => {
  const { move, station } = await start(t);
  const r = await move('cortez', 'NB/SB', { lat: cortez.lat + 0.002, lng: cortez.lng + 0.002, note: 'x' });
  assert.equal(r.status, 200);
  assert.equal((await station('cortez')).locations[0].correction.note, 'x');
});

test('bad requests are refused with a message and change nothing', async (t) => {
  const { move, station, base } = await start(t);
  const refused = async (body, status, pattern) => {
    const r = await move('limon', 'WB', body);
    assert.equal(r.status, status, JSON.stringify(body));
    if (pattern) assert.match((await r.json()).error, pattern);
  };
  await refused({ lat: '39.3', lng: -103.7 }, 400, /numbers/);
  await refused({ lat: 39.3 }, 400, /numbers/);
  await refused({ lat: WB.lng, lng: WB.lat }, 400, /outside Colorado/);              // swapped
  await refused({ lat: WB.lat, lng: -WB.lng }, 400, /outside Colorado/);             // missing minus sign
  await refused({ lat: 37.2, lng: -108.0 }, 400, /miles from CDOT's position/);      // inside Colorado, far away
  await refused({ ...nearWB, note: 'x'.repeat(281) }, 400, /280/);
  await refused('{not json', 400);
  await refused(JSON.stringify({ ...nearWB, note: 'x'.repeat(3000) }), 400, /too large/);

  assert.equal((await move('nowhere', 'WB', nearWB)).status, 404);
  assert.equal((await move('limon', 'NB', nearWB)).status, 404);                     // Limon has no NB pin
  const badEncoding = await fetch(`${base}/api/stations/limon/locations/%E0%A4%A/position`, { method: 'PUT', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(badEncoding.status, 400);
  assert.equal((await fetch(`${base}/api/stations/limon/locations/WB/position`, { method: 'POST', headers: { authorization: 'Bearer secret' } })).status, 405);
  assert.equal((await station('limon')).locations.find((l) => l.direction === 'WB').correction, undefined);
});

test('reverting puts the pin back to CDOT\'s position; reverting twice is a 404', async (t) => {
  const { move, revert, station } = await start(t);
  await move('limon', 'WB', nearWB);
  const r = await revert('limon', 'WB');
  assert.equal(r.status, 200);
  const back = await r.json();
  assert.deepEqual([back.lat, back.lng, back.correction, back.original], [WB.lat, WB.lng, undefined, undefined]);
  assert.equal((await station('limon')).locations.find((l) => l.direction === 'WB').lat, WB.lat);
  assert.equal((await revert('limon', 'WB')).status, 404);
});

test('every save and revert is recorded in a public history, newest first', async (t) => {
  const { move, revert, base } = await start(t);
  await move('limon', 'WB', nearWB);
  await move('limon', 'WB', { ...nearWB, note: 'moved again' });
  await revert('limon', 'WB');
  const h = await (await fetch(`${base}/api/stations/limon/positions`)).json();
  assert.deepEqual(h.map((e) => e.action), ['revert', 'move', 'move']);
  assert.equal(h[1].note, 'moved again');
  assert.deepEqual(h[2].previous, { lat: WB.lat, lng: WB.lng });
  assert.equal((await (await fetch(`${base}/api/stations/cortez/positions`)).json()).length, 0);
  assert.equal((await fetch(`${base}/api/stations/nowhere/positions`)).status, 404);
});

test('saved positions survive a restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-'));
  t.after(() => rm(dir, { recursive: true }));
  const first = await start(t, { dir });
  await first.move('limon', 'WB', nearWB);
  first.server.close(); first.server.closeAllConnections();
  const second = await start(t, { dir });
  const s = await second.station('limon');
  assert.equal(s.locations.find((l) => l.direction === 'WB').correction.note, 'moved to the new building');
});

test('when CDOT\'s own position catches up with the saved one, the page is told', async (t) => {
  const { move } = await start(t);
  const r = await (await move('limon', 'WB', { lat: WB.lat + 0.0001, lng: WB.lng, note: 'same place' })).json(); // about 11 metres
  assert.equal(r.correction.cdotAgrees, true);
});

test('the port circle on the inspection map follows the pins, and returns when they are reverted', async (t) => {
  const { move, revert, portCircle } = await start(t);
  const before = await portCircle();
  const expected = centroid(limon.locations);
  assert.ok(Math.abs(before.lat - expected.lat) < 1e-4 && Math.abs(before.lng - expected.lng) < 1e-4); // starts at the pins' average

  await move('limon', 'WB', { lat: WB.lat + 0.02, lng: WB.lng, note: 'moved' });
  const moved = await portCircle();
  assert.ok(Math.abs(moved.lat - (before.lat + 0.01)) < 1e-4, 'the circle moved by half of the pin\'s move');
  await revert('limon', 'WB');
  const back = await portCircle();
  assert.ok(Math.abs(back.lat - before.lat) < 1e-9);
});
