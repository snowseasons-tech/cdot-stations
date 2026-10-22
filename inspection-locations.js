// Per-location North American Standard inspection counts for the map, filtered by inspection level and period.
import { LEVELS, VEHICLE_LEVELS, DRIVER_LEVELS } from './inspections.js';

export const PERIODS = ['12m', 'all'];
const ALL_LEVELS = [1, 2, 3, 4, 5];
const SLOT = { '12m': 3, all: 0 }; // index of the [total, vehicleOos, driverOos] triple within a level's counts

// "1,3,5" -> [1, 3, 5]; null/empty -> all levels; anything invalid -> null.
export function parseLevels(param) {
  if (param == null || param === '') return ALL_LEVELS;
  const parts = param.split(',');
  const levels = [...new Set(parts.map(Number))].sort((a, b) => a - b);
  return levels.length && levels.every((l) => ALL_LEVELS.includes(l)) ? levels : null;
}

const rate = (part, whole) => (whole ? part / whole : null);

export function summarizeLocations(data, { levels = ALL_LEVELS, period = '12m' } = {}) {
  if (!data) return { through: null, period, levels, coverage: null, locations: [] };
  const slot = SLOT[period];
  const locations = [];
  for (const l of data.locations) {
    let total = 0, vehicleOos = 0, vehicleInsp = 0, driverOos = 0, driverInsp = 0;
    const byLevel = [];
    for (const level of levels) {
      const c = l.levels[level];
      const [t, v, d] = c ? c.slice(slot, slot + 3) : [0, 0, 0];
      if (!t) continue;
      total += t;
      if (VEHICLE_LEVELS.has(String(level))) { vehicleInsp += t; vehicleOos += v; }
      if (DRIVER_LEVELS.has(String(level))) { driverInsp += t; driverOos += d; }
      byLevel.push({ level, name: LEVELS[level], count: t });
    }
    if (!total) continue;
    locations.push({
      id: l.id, name: l.name, kind: l.kind, station: l.station ?? null, lat: l.lat, lng: l.lng,
      total, vehicleOosRate: rate(vehicleOos, vehicleInsp), driverOosRate: rate(driverOos, driverInsp), byLevel,
    });
  }
  locations.sort((a, b) => b.total - a.total);
  const { mapped, unmapped } = data.coverage;
  return { through: data.through, period, levels, coverage: { mapped, unmapped, mappedShare: rate(mapped, mapped + unmapped) }, locations };
}
