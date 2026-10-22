// Pulls FMCSA's public Vehicle Inspection File (data.transportation.gov, dataset fx4q-ay7w) for Colorado
// and aggregates North American Standard inspections at the fixed ports into data/inspections.json.
//
// A port's inspections are rows with insp_facility = 'F' (fixed facility) whose location_desc is the
// port's town, e.g. "LIMON CO". Roadside ('R') rows in the same town are patrol stops, not port inspections.
import { readFile, writeFile } from 'node:fs/promises';

const ENDPOINT = 'https://data.transportation.gov/resource/fx4q-ay7w.json';
const STATIONS = new URL('../data/stations.json', import.meta.url);
const OUT = new URL('../data/inspections.json', import.meta.url);

export const locationDesc = (station) => `${station.name.toUpperCase()} CO`;

export function buildRows(stations, total, vehicleOos, driverOos) {
  const idByDesc = new Map(stations.map((s) => [locationDesc(s), s.id]));
  const rows = new Map();
  const key = (r) => `${idByDesc.get(r.location_desc)}|${r.month}|${r.insp_level_id}`;
  const add = (data, field) => {
    for (const r of data) {
      const station = idByDesc.get(r.location_desc);
      if (!station) continue;
      const k = key(r);
      if (!rows.has(k)) rows.set(k, { station, month: r.month, level: r.insp_level_id, total: 0, vehicleOos: 0, driverOos: 0 });
      rows.get(k)[field] = Number(r.n);
    }
  };
  add(total, 'total');
  add(vehicleOos, 'vehicleOos');
  add(driverOos, 'driverOos');
  return [...rows.values()].sort((a, b) => a.station.localeCompare(b.station) || a.month.localeCompare(b.month) || a.level.localeCompare(b.level));
}

async function query(stations, extraWhere = '') {
  const descs = stations.map((s) => `'${locationDesc(s).replace(/'/g, "''")}'`).join(',');
  const params = new URLSearchParams({
    $select: 'location_desc,insp_level_id,substring(insp_date,1,6) as month,count(*) as n',
    $where: `report_state='CO' AND insp_facility='F' AND location_desc in(${descs})${extraWhere}`,
    $group: 'location_desc,insp_level_id,month',
    $limit: '50000',
  });
  const res = await fetch(`${ENDPOINT}?${params}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`FMCSA data service returned ${res.status}`);
  return res.json();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { stations } = JSON.parse(await readFile(STATIONS, 'utf8'));
  const [total, vehicleOos, driverOos] = await Promise.all([
    query(stations),
    query(stations, " AND vehicle_oos_total!='0'"),
    query(stations, " AND driver_oos_total!='0'"),
  ]);
  const rows = buildRows(stations, total, vehicleOos, driverOos);
  if (!rows.length) throw new Error('FMCSA returned no inspections; refusing to overwrite data/inspections.json');
  const through = rows.reduce((m, r) => (r.month > m ? r.month : m), '');
  await writeFile(OUT, JSON.stringify({ source: ENDPOINT, fetchedAt: new Date().toISOString(), through, rows }) + '\n');
  console.log(`Wrote ${rows.length} rows, ${rows.reduce((n, r) => n + r.total, 0)} inspections, through ${through}`);
}
