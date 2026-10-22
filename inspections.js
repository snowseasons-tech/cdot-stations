// Summaries of North American Standard inspections (CVSA levels) per station.
export const LEVELS = {
  1: 'Full (driver + vehicle)',
  2: 'Walk-around',
  3: 'Driver / credentials',
  4: 'Special study',
  5: 'Vehicle only',
  6: 'Enhanced (radioactive)',
  7: 'Jurisdictional mandated',
};

const monthsBack = (through, n) => {
  const [y, m] = [Number(through.slice(0, 4)), Number(through.slice(4))];
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
};

// Each OOS rate only counts inspections that actually covered that part: Level III is driver-only
// and Level V is vehicle-only, so including them would dilute the other rate.
export const VEHICLE_LEVELS = new Set(['1', '2', '5', '6']);
export const DRIVER_LEVELS = new Set(['1', '2', '3', '6']);

const rate = (part, whole) => (whole ? part / whole : null);

// Rolls up the last `months` months ending at the dataset's most recent month.
export function summarize(data, stationId, months = 12) {
  if (!data?.rows?.length) return { total: 0, months: [], byLevel: [], vehicleOosRate: null, driverOosRate: null, through: null };
  const window = monthsBack(data.through, months);
  const inWindow = new Set(window);
  const rows = data.rows.filter((r) => r.station === stationId && inWindow.has(r.month));

  const byMonth = new Map(window.map((m) => [m, 0]));
  const levels = new Map();
  let total = 0, vehicleOos = 0, vehicleInsp = 0, driverOos = 0, driverInsp = 0;
  for (const r of rows) {
    total += r.total;
    if (VEHICLE_LEVELS.has(r.level)) { vehicleInsp += r.total; vehicleOos += r.vehicleOos; }
    if (DRIVER_LEVELS.has(r.level)) { driverInsp += r.total; driverOos += r.driverOos; }
    byMonth.set(r.month, byMonth.get(r.month) + r.total);
    levels.set(r.level, (levels.get(r.level) ?? 0) + r.total);
  }
  return {
    total,
    through: data.through,
    vehicleOosRate: rate(vehicleOos, vehicleInsp),
    driverOosRate: rate(driverOos, driverInsp),
    months: [...byMonth].map(([month, count]) => ({ month, count })),
    byLevel: [...levels].sort(([a], [b]) => a - b).map(([level, count]) => ({ level: Number(level), name: LEVELS[level] ?? `Level ${level}`, count })),
  };
}
