// Pulls CDOT's Ports of Entry layer and writes data/stations.json.
// One station per port name; each travel direction becomes a location.
import { writeFile } from 'node:fs/promises';

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

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`CDOT service returned ${res.status}`);
  const { features } = await res.json();
  const stations = groupStations(features);
  await writeFile(OUT, JSON.stringify({ source: SOURCE, fetchedAt: new Date().toISOString(), stations }, null, 2) + '\n');
  console.log(`Wrote ${stations.length} stations (${features.length} locations)`);
}
