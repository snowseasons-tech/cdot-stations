// CDOT/FMCSA data for the inspection portal, read at build time from this app's data files
// (refreshed weekly; run `npm run build` here to pick up a refresh). Rollups match ../../inspections.js.
import stationsFile from '../../data/stations.json';
import inspectionsFile from '../../data/inspections.json';
import locationsFile from '../../data/inspection-locations.json';

export const LEVELS = {
  1: 'Full (driver + vehicle)',
  2: 'Walk-around',
  3: 'Driver / credentials',
  4: 'Special study',
  5: 'Vehicle only',
};

// Each OOS rate only counts inspections that covered that part: Level III is driver-only, Level V vehicle-only.
const VEHICLE_LEVELS = new Set(['1', '2', '5', '6']);
const DRIVER_LEVELS = new Set(['1', '2', '3', '6']);
const rate = (part, whole) => (whole ? part / whole : null);

export const THROUGH = inspectionsFile.through; // YYYYMM, the latest (usually partial) month
export const FETCHED_AT = inspectionsFile.fetchedAt;
export const COVERAGE = locationsFile.coverage;

const monthsBack = (through, n) => {
  const [y, m] = [Number(through.slice(0, 4)), Number(through.slice(4))];
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - n + i, 1));
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
};
export const LAST_12 = monthsBack(THROUGH, 12);

export const monthLabel = (ym, withYear = false) =>
  new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(4)) - 1, 1))
    .toLocaleDateString('en-US', { month: 'short', year: withYear ? 'numeric' : undefined, timeZone: 'UTC' });

// Rolls rows ({ month, level, total, vehicleOos, driverOos }) up over a set of months.
function rollup(rows, months) {
  const inWindow = new Set(months);
  const byMonth = new Map(months.map(m => [m, { total: 0, vehicleOos: 0, vehicleInsp: 0 }]));
  const byLevel = {};
  let total = 0, vehicleOos = 0, vehicleInsp = 0, driverOos = 0, driverInsp = 0;
  for (const r of rows) {
    if (!inWindow.has(r.month)) continue;
    const m = byMonth.get(r.month);
    total += r.total; m.total += r.total;
    byLevel[r.level] = (byLevel[r.level] || 0) + r.total;
    if (VEHICLE_LEVELS.has(r.level)) { vehicleInsp += r.total; vehicleOos += r.vehicleOos; m.vehicleInsp += r.total; m.vehicleOos += r.vehicleOos; }
    if (DRIVER_LEVELS.has(r.level)) { driverInsp += r.total; driverOos += r.driverOos; }
  }
  return {
    total, byLevel,
    vehicleOosRate: rate(vehicleOos, vehicleInsp),
    driverOosRate: rate(driverOos, driverInsp),
    months: [...byMonth].map(([month, v]) => ({ month, total: v.total, vehicleOosRate: rate(v.vehicleOos, v.vehicleInsp) })),
  };
}

// The 10 ports of entry, with their last 12 months of inspections.
export const PORTS = stationsFile.stations.map(s => ({
  ...s,
  kind: 'port',
  lat: s.locations[0].lat,
  lng: s.locations[0].lng,
  last12: rollup(inspectionsFile.rows.filter(r => r.station === s.id), LAST_12),
})).sort((a, b) => b.last12.total - a.last12.total);

// All months the port data covers, for the statewide trend.
const ALL_MONTHS = [...new Set(inspectionsFile.rows.map(r => r.month))].sort();
export const PORT_TREND = rollup(inspectionsFile.rows, ALL_MONTHS);
export const PORTS_LAST_12 = rollup(inspectionsFile.rows, LAST_12);

// Towns where FMCSA recorded roadside inspections. Per level: [all, vehicleOos, driverOos, last12, vehicleOos12, driverOos12].
const townStats = (levels, level, offset) => {
  let total = 0, vehicleOos = 0, vehicleInsp = 0, driverOos = 0, driverInsp = 0;
  for (const [lv, c] of Object.entries(levels)) {
    if (level !== 'All' && lv !== level) continue;
    total += c[offset];
    if (VEHICLE_LEVELS.has(lv)) { vehicleInsp += c[offset]; vehicleOos += c[offset + 1]; }
    if (DRIVER_LEVELS.has(lv)) { driverInsp += c[offset]; driverOos += c[offset + 2]; }
  }
  return { total, vehicleOosRate: rate(vehicleOos, vehicleInsp), driverOosRate: rate(driverOos, driverInsp) };
};
export const TOWNS = locationsFile.locations
  .filter(l => l.kind === 'place')
  .map(l => ({
    id: l.id, name: l.name, kind: 'town', lat: l.lat, lng: l.lng, levels: l.levels,
    last12: level => townStats(l.levels, level, 3),
    allTime: level => townStats(l.levels, level, 0),
  }));

// Every mapped Colorado inspection in the last 12 months (towns and ports), by the town data's own counts.
export const STATE_LAST_12 = locationsFile.locations.reduce((n, l) => n + Object.values(l.levels).reduce((m, c) => m + c[3], 0), 0);
