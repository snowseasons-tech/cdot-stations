import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { parseLevels, summarizeLocations } from '../inspection-locations.js';
import { buildLocations, classify, portIndex, shrankTooMuch, windowStart } from '../scripts/sync-inspection-locations.js';
import { parseGazetteer } from '../scripts/build-places.js';
import { cleanName } from '../scripts/place-names.js';

const stations = [
  { id: 'limon', name: 'Limon', locations: [{ lat: 39.27, lng: -103.69 }, { lat: 39.28, lng: -103.69 }] },
  { id: 'dumont', name: 'Dumont', locations: [{ lat: 39.77, lng: -105.61 }] },
  { id: 'fort-collins', name: 'Fort Collins', locations: [{ lat: 40.55, lng: -105.0 }] },
];
const places = {
  LIMON: { name: 'Limon', lat: 39.265, lng: -103.686 },
  'COMMERCE CITY': { name: 'Commerce City', lat: 39.88, lng: -104.79 },
  'CANON CITY': { name: 'Cañon City', lat: 38.44, lng: -105.22 },
};
const ports = portIndex(stations);

test('cleanName: diacritics, punctuation, and suffix handling', () => {
  assert.equal(cleanName('Cañon City city', { stripSuffix: true }), 'CANON CITY');
  assert.equal(cleanName('COMMERCE CITY'), 'COMMERCE CITY'); // inspection text keeps its "CITY"
  assert.equal(cleanName("Snowmass Village town", { stripSuffix: true }), 'SNOWMASS VILLAGE');
  assert.equal(cleanName('  Fort   Collins '), 'FORT COLLINS');
});

test('classify places port strings, port-town fixed facilities, towns and roadside stops', () => {
  assert.deepEqual(classify('LIMON POE WB', 'F', ports, places).id, 'port:limon');
  assert.equal(classify('FORT COLLINS PORT OF ENTRY SB', 'F', ports, places).id, 'port:fort-collins');
  assert.equal(classify('LIMON CO', 'F', ports, places).kind, 'port'); // fixed facility in a port town = the port
  const roadside = classify('LIMON CO', 'R', ports, places);
  assert.equal(roadside.kind, 'place');
  assert.equal(roadside.lat, 39.265); // town centroid, not the port
  const dumontRoadside = classify('DUMONT CO', 'R', ports, places);
  assert.equal(dumontRoadside.kind, 'place'); // not in the gazetteer: falls back to the port's coordinates
  assert.equal(dumontRoadside.lat, 39.77);
  assert.equal(classify('COMMERCE CITY CO', 'R', ports, places).name, 'Commerce City');
  assert.equal(classify('CANON CITY CO', 'R', ports, places).name, 'Cañon City');
});

test('classify refuses to guess', () => {
  for (const d of ['H36 MP174 COPE @H59', 'HIGHWAY 160', 'WOODROW CO', 'NOWHERE POE', '', null]) assert.equal(classify(d, 'R', ports, places), null, String(d));
});

test('buildLocations merges rows into per-level count tuples and tallies unmapped inspections', () => {
  const row = (d, f, l, n) => ({ location_desc: d, insp_facility: f, insp_level_id: l, n: String(n) });
  const out = buildLocations(stations, places, {
    all: [row('LIMON POE WB', 'F', '1', 10), row('LIMON CO', 'F', '1', 5), row('LIMON CO', 'R', '3', 4), row('WOODROW CO', 'R', '2', 7)],
    vehicleOos: [row('LIMON POE WB', 'F', '1', 3)], driverOos: [row('LIMON CO', 'R', '3', 1)],
    recent: [row('LIMON CO', 'F', '1', 2)], recentVehicleOos: [], recentDriverOos: [],
  });
  const port = out.locations.find((l) => l.id === 'port:limon');
  assert.deepEqual(port.levels['1'], [15, 3, 0, 2, 0, 0]); // POE string + fixed-facility rows merged
  assert.deepEqual(out.locations.find((l) => l.id === 'place:limon').levels['3'], [4, 0, 1, 0, 0, 0]);
  assert.deepEqual(out.coverage, { mapped: 19, unmapped: 7, unmappedLocations: 1 });
});

test('windowStart, shrink guard, and gazetteer parsing', () => {
  assert.equal(windowStart('202610'), '20251101');
  assert.equal(windowStart('202602'), '20250301');
  const loc = (t) => [{ levels: { 1: [t, 0, 0, 0, 0, 0] } }];
  assert.equal(shrankTooMuch(loc(1000), loc(900)), false);
  assert.equal(shrankTooMuch(loc(1000), loc(700)), true);
  const gaz = 'USPS|GEOID|NAME|INTPTLAT|INTPTLONG\nCO|1|Lamar city|38.07|-102.61\nCO|2|Glendale city|39.7|-104.9\nCO|3|Glendale CDP|40.0|-105.0\n';
  const { places: p, ambiguous } = parseGazetteer(gaz);
  assert.deepEqual(Object.keys(p), ['LAMAR']);
  assert.deepEqual(ambiguous, ['GLENDALE']);
});

const data = {
  through: '202610', coverage: { mapped: 90, unmapped: 10 },
  locations: [
    { id: 'port:limon', name: 'Limon', kind: 'port', station: 'limon', lat: 39.27, lng: -103.69, levels: { 1: [100, 20, 10, 40, 8, 4], 3: [300, 0, 30, 120, 0, 12], 5: [10, 5, 0, 4, 2, 0] } },
    { id: 'place:golden', name: 'Golden', kind: 'place', lat: 39.75, lng: -105.22, levels: { 2: [50, 5, 0, 0, 0, 0] } },
  ],
};

test('parseLevels', () => {
  assert.deepEqual(parseLevels(null), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseLevels('3,1,3'), [1, 3]);
  for (const bad of ['0', '6', 'a', '1,x', '1.5']) assert.equal(parseLevels(bad), null, bad);
});

test('summarizeLocations filters by level and period, drops empty locations, and uses per-level OOS denominators', () => {
  const all = summarizeLocations(data, { levels: [1, 2, 3, 4, 5], period: 'all' });
  assert.deepEqual(all.locations.map((l) => [l.id, l.total]), [['port:limon', 410], ['place:golden', 50]]);
  const limon = all.locations[0];
  assert.equal(limon.vehicleOosRate, 25 / 110); // levels 1 and 5 only; level 3 is driver-only
  assert.equal(limon.driverOosRate, 40 / 400); // levels 1 and 3 only; level 5 is vehicle-only
  assert.equal(all.coverage.mappedShare, 0.9);

  const recent = summarizeLocations(data, { levels: [2], period: '12m' });
  assert.deepEqual(recent.locations, []); // golden has nothing in the last 12 months at level 2
  const lv3 = summarizeLocations(data, { levels: [3], period: '12m' });
  assert.deepEqual(lv3.locations.map((l) => [l.id, l.total, l.vehicleOosRate]), [['port:limon', 120, null]]);
  assert.deepEqual(summarizeLocations(null).locations, []);
});

async function start(t, locationsData) {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-'));
  const locationsFile = join(dir, 'locations.json');
  if (locationsData) await writeFile(locationsFile, JSON.stringify(locationsData));
  const server = await createApp({ statusFile: join(dir, 'status.json'), locationsFile });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('GET /api/inspection-locations: filters, validation, and missing data file', async (t) => {
  const base = await start(t, data);
  const d = await (await fetch(`${base}/api/inspection-locations?levels=1,3&period=all`)).json();
  assert.deepEqual(d.locations.map((l) => l.total), [400]);
  assert.deepEqual(d.levels, [1, 3]);
  assert.equal((await (await fetch(`${base}/api/inspection-locations`)).json()).period, '12m'); // defaults
  assert.equal((await fetch(`${base}/api/inspection-locations?levels=9`)).status, 400);
  assert.equal((await fetch(`${base}/api/inspection-locations?period=forever`)).status, 400);
  assert.equal((await fetch(`${base}/api/inspection-locations`, { method: 'POST' })).status, 405);

  const empty = await start(t, null);
  assert.deepEqual((await (await fetch(`${empty}/api/inspection-locations`)).json()).locations, []);
});
