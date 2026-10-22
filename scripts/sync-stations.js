// Pulls CDOT's Ports of Entry layer and writes data/stations.json.
// One station per port name; each travel direction becomes a location.
import { readPrevious, writeIfChanged } from './data-file.js';

const SOURCE =
  'https://services.arcgis.com/yzB9WM8W0BO3Ql7d/ArcGIS/rest/services/POELocations/FeatureServer/0/query' +
  '?where=1%3D1&outFields=*&f=geojson';
const OUT = new URL('../data/stations.json', import.meta.url);

export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function groupStations(features) {
  const byName = new Map();
  for (const { geometry, properties: p } of features) {
    const planned = /future|not open/i.test(`${p.Port_Name} ${p.Phone}`);
    const name = p.Port_Name.replace(/\s*future\s*site\s*/i, '').trim();
    const id = slug(name);
    if (!byName.has(id)) {
      byName.set(id, { id, name, highway: p.Highway, planned, phone: planned ? null : p.Phone, locations: [] });
    }
    byName.get(id).locations.push({
      direction: p.Direction,
      milepost: Number(p.Mile_Post),
      lat: geometry.coordinates[1],
      lng: geometry.coordinates[0],
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// A refresh must not silently drop stations: their ids key the saved status history.
export function removedStations(previous, next) {
  const kept = new Set(next.map((s) => s.id));
  return (previous?.stations ?? []).map((s) => s.id).filter((id) => !kept.has(id));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`CDOT service returned ${res.status}`);
  const { features } = await res.json();
  const stations = groupStations(features);
  if (!stations.length) throw new Error('CDOT returned no stations; refusing to overwrite data/stations.json');
  const previous = await readPrevious(OUT);
  const removed = removedStations(previous, stations);
  if (removed.length && process.env.FORCE !== '1') {
    throw new Error(`CDOT's layer no longer lists: ${removed.join(', ')}. Review, then re-run with FORCE=1 if that's right.`);
  }
  const changed = await writeIfChanged(OUT, previous, { source: SOURCE, fetchedAt: new Date().toISOString(), stations }, 2);
  console.log(changed ? `Updated ${stations.length} stations (${features.length} locations)` : 'Stations: no changes');
}
