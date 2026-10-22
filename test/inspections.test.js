import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { summarize } from '../inspections.js';
import { buildRows } from '../scripts/sync-inspections.js';

const data = {
  through: '202602',
  rows: [
    { station: 'limon', month: '202602', level: '1', total: 10, vehicleOos: 2, driverOos: 1 },
    { station: 'limon', month: '202602', level: '3', total: 30, vehicleOos: 0, driverOos: 3 },
    { station: 'limon', month: '202511', level: '2', total: 60, vehicleOos: 6, driverOos: 0 },
    { station: 'limon', month: '202401', level: '2', total: 99, vehicleOos: 99, driverOos: 99 },
    { station: 'cortez', month: '202602', level: '1', total: 5, vehicleOos: 0, driverOos: 0 },
  ],
};

test('summarize rolls up the window ending at the latest data month', () => {
  const s = summarize(data, 'limon', 12);
  assert.equal(s.total, 100);
  assert.equal(s.months.length, 12);
  assert.equal(s.months.at(-1).month, '202602');
  assert.equal(s.months.find((m) => m.month === '202511').count, 60);
  // vehicle: levels 1+2 -> 8 OOS of 70 inspections; driver: levels 1+2+3 -> 4 of 100. Level 3 is excluded from the vehicle rate.
  assert.equal(s.vehicleOosRate, 8 / 70);
  assert.equal(s.driverOosRate, 0.04);
  assert.deepEqual(s.byLevel.map((l) => [l.level, l.count]), [[1, 10], [2, 60], [3, 30]]);
});

test('summarize handles year boundaries, wider windows, and missing data', () => {
  assert.equal(summarize(data, 'limon', 3).months[0].month, '202512');
  assert.equal(summarize(data, 'limon', 36).total, 199);
  assert.equal(summarize(data, 'nowhere').total, 0);
  const none = summarize(null, 'limon');
  assert.equal(none.total, 0);
  assert.equal(none.vehicleOosRate, null);
});

test('buildRows merges the three queries by station, month and level', () => {
  const stations = [{ id: 'limon', name: 'Limon' }, { id: 'fort-collins', name: 'Fort Collins' }];
  const q = (loc, level, n) => ({ location_desc: loc, insp_level_id: level, month: '202601', n: String(n) });
  const rows = buildRows(stations, [q('LIMON CO', '1', 10), q('FORT COLLINS CO', '2', 4), q('GOLDEN CO', '1', 99)], [q('LIMON CO', '1', 3)], []);
  assert.deepEqual(rows, [
    { station: 'fort-collins', month: '202601', level: '2', total: 4, vehicleOos: 0, driverOos: 0 },
    { station: 'limon', month: '202601', level: '1', total: 10, vehicleOos: 3, driverOos: 0 },
  ]);
});

async function start(t, inspections) {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-'));
  const inspectionsFile = join(dir, 'inspections.json');
  if (inspections) await writeFile(inspectionsFile, JSON.stringify(inspections));
  const server = await createApp({ statusFile: join(dir, 'status.json'), inspectionsFile });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('inspections endpoint and list summary', async (t) => {
  const base = await start(t, data);
  const d = await (await fetch(`${base}/api/stations/limon/inspections?months=36`)).json();
  assert.equal(d.total, 199);
  const { stations } = await (await fetch(`${base}/api/stations`)).json();
  assert.equal(stations.find((s) => s.id === 'limon').inspections.total, 100);
  assert.equal((await fetch(`${base}/api/stations/limon/inspections?months=0`)).status, 400);
  assert.equal((await fetch(`${base}/api/stations/limon/inspections?months=abc`)).status, 400);
  assert.equal((await fetch(`${base}/api/stations/nowhere/inspections`)).status, 404);
});

test('app still works without an inspections file', async (t) => {
  const base = await start(t, null);
  const d = await (await fetch(`${base}/api/stations/limon/inspections`)).json();
  assert.equal(d.total, 0);
});
