// Builds data/inspection-locations.json: Colorado level 1-5 inspections from FMCSA's public Vehicle Inspection File,
// aggregated per mappable location. FMCSA records have no coordinates, only a place description, so each one is placed:
//   - "LIMON POE WB" / "LAMAR PORT OF ENTRY" and fixed-facility ('F') inspections in a port's town -> that port's coordinates
//   - "<TOWN> CO" -> the town's centroid from data/co-places.json (US Census gazetteer; see scripts/build-places.js)
//   - anything else (unincorporated places, free-text highway mileposts) is counted as unmapped, not guessed at
import { readFile } from 'node:fs/promises';
import { readPrevious, writeIfChanged } from './data-file.js';
import { cleanName } from './place-names.js';

const ENDPOINT = 'https://data.transportation.gov/resource/fx4q-ay7w.json';
const STATIONS = new URL('../data/stations.json', import.meta.url);
const PLACES = new URL('../data/co-places.json', import.meta.url);
const OUT = new URL('../data/inspection-locations.json', import.meta.url);
const LEVELS = ['1', '2', '3', '4', '5'];

const POE = /^(.*?)\s+(?:POE|PORT OF ENTRY)\b/i;
const TOWN = /^(.*?)\s+CO$/i;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function portIndex(stations) {
  return new Map(stations.map((s) => [cleanName(s.name), {
    station: s.id, name: s.name, lat: mean(s.locations.map((l) => l.lat)), lng: mean(s.locations.map((l) => l.lng)),
  }]));
}

// Returns { id, name, kind, station?, lat, lng } for the place an inspection record refers to, or null if it can't be placed.
export function classify(desc, facility, ports, places) {
  const text = String(desc ?? '').trim();
  const poe = text.match(POE);
  if (poe) {
    const port = ports.get(cleanName(poe[1]));
    return port ? { id: `port:${port.station}`, name: port.name, kind: 'port', station: port.station, lat: port.lat, lng: port.lng } : null;
  }
  const town = text.match(TOWN);
  if (!town) return null;
  const key = cleanName(town[1]);
  const port = ports.get(key);
  if (port && facility === 'F') return { id: `port:${port.station}`, name: port.name, kind: 'port', station: port.station, lat: port.lat, lng: port.lng };
  const place = places[key];
  if (place) return { id: `place:${slug(key)}`, name: place.name, kind: 'place', lat: place.lat, lng: place.lng };
  // roadside stops in a port's town that the gazetteer doesn't list (e.g. Dumont): pin at the port, as the town
  if (port) return { id: `place:${slug(key)}`, name: port.name, kind: 'place', lat: port.lat, lng: port.lng };
  return null;
}

// results: { all, vehicleOos, driverOos, recent, recentVehicleOos, recentDriverOos }, each rows of
// { location_desc, insp_facility, insp_level_id, n }. Per level the counts are [total, vehicleOos, driverOos, total12, vehicleOos12, driverOos12].
export function buildLocations(stations, places, results) {
  const ports = portIndex(stations);
  const locations = new Map();
  const unmapped = { inspections: 0, locations: new Set() };
  let mapped = 0;

  const slots = { all: 0, vehicleOos: 1, driverOos: 2, recent: 3, recentVehicleOos: 4, recentDriverOos: 5 };
  for (const [name, slot] of Object.entries(slots)) {
    for (const r of results[name]) {
      const n = Number(r.n);
      const place = classify(r.location_desc, r.insp_facility, ports, places);
      if (!place) {
        if (name === 'all') { unmapped.inspections += n; unmapped.locations.add(r.location_desc); }
        continue;
      }
      if (name === 'all') mapped += n;
      if (!locations.has(place.id)) locations.set(place.id, { ...place, levels: {} });
      const levels = locations.get(place.id).levels;
      levels[r.insp_level_id] ??= [0, 0, 0, 0, 0, 0];
      levels[r.insp_level_id][slot] += n;
    }
  }
  const sorted = [...locations.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const l of sorted) l.levels = Object.fromEntries(Object.entries(l.levels).sort(([a], [b]) => a - b));
  return { locations: sorted, coverage: { mapped, unmapped: unmapped.inspections, unmappedLocations: unmapped.locations.size } };
}

async function query(extraWhere = '') {
  const params = new URLSearchParams({
    $select: 'location_desc,insp_facility,insp_level_id,count(*) as n',
    $where: `report_state='CO' AND insp_level_id in(${LEVELS.map((l) => `'${l}'`).join(',')})${extraWhere}`,
    $group: 'location_desc,insp_facility,insp_level_id',
    $limit: '50000',
  });
  const res = await fetch(`${ENDPOINT}?${params}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`FMCSA data service returned ${res.status}`);
  return res.json();
}

async function latestMonth() {
  const params = new URLSearchParams({ $select: 'max(insp_date) as d', $where: "report_state='CO'" });
  const res = await fetch(`${ENDPOINT}?${params}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`FMCSA data service returned ${res.status}`);
  return (await res.json())[0].d.slice(0, 6);
}

// First day of the 12-month window ending at `through` (YYYYMM), as YYYYMMDD: through=202610 -> 20251101
export function windowStart(through) {
  const d = new Date(Date.UTC(Number(through.slice(0, 4)), Number(through.slice(4)) - 12, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}01`;
}

const total = (locations, i = 0) => locations.reduce((n, l) => n + Object.values(l.levels).reduce((m, c) => m + c[i], 0), 0);

// FMCSA only publishes a rolling window, so some shrinkage is normal; a big drop means a bad fetch.
export function shrankTooMuch(previous, next, limit = 0.2) {
  const before = total(previous ?? []);
  return before > 0 && total(next) < before * (1 - limit);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { stations } = JSON.parse(await readFile(STATIONS, 'utf8'));
  const { places } = JSON.parse(await readFile(PLACES, 'utf8'));
  const through = await latestMonth();
  const since = ` AND insp_date>='${windowStart(through)}'`;
  const veh = " AND vehicle_oos_total!='0'";
  const drv = " AND driver_oos_total!='0'";
  const [all, vehicleOos, driverOos, recent, recentVehicleOos, recentDriverOos] = await Promise.all([
    query(), query(veh), query(drv), query(since), query(since + veh), query(since + drv),
  ]);
  const { locations, coverage } = buildLocations(stations, places, { all, vehicleOos, driverOos, recent, recentVehicleOos, recentDriverOos });
  if (!locations.length) throw new Error('No locations could be placed; refusing to overwrite data/inspection-locations.json');
  const previous = await readPrevious(OUT);
  if (shrankTooMuch(previous?.locations, locations) && process.env.FORCE !== '1') {
    throw new Error(`New data has ${total(locations)} inspections vs ${total(previous.locations)} before (more than 20% fewer). Review, then re-run with FORCE=1 if that's right.`);
  }
  const changed = await writeIfChanged(OUT, previous, { source: ENDPOINT, fetchedAt: new Date().toISOString(), through, coverage, locations });
  const pct = ((coverage.mapped / (coverage.mapped + coverage.unmapped)) * 100).toFixed(1);
  console.log(changed
    ? `Updated: ${locations.length} locations, ${coverage.mapped} inspections mapped (${pct}%), ${coverage.unmapped} unmapped, through ${through}`
    : 'Inspection locations: no changes');
}
