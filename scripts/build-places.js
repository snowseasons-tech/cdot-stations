// One-off builder for data/co-places.json: Colorado place names -> coordinates, from the US Census Gazetteer.
//   npm run build:places
// The result is committed, so the regular data refresh doesn't depend on Census. Names shared by several places
// (e.g. "Glendale") are left out rather than guessed at.
import { writeFile } from 'node:fs/promises';
import { cleanName } from './place-names.js';

const SOURCE = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_gaz_place_08.txt';
const OUT = new URL('../data/co-places.json', import.meta.url);

export function parseGazetteer(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const cols = header.split('|').map((c) => c.trim());
  const idx = Object.fromEntries(cols.map((c, i) => [c, i]));
  const byKey = new Map();
  const ambiguous = new Set();
  for (const line of lines) {
    const f = line.split('|').map((v) => v.trim());
    const key = cleanName(f[idx.NAME], { stripSuffix: true });
    const place = { name: f[idx.NAME].replace(/\s+(city and county|city|town|CDP|municipality|village|borough)$/i, ''), lat: Number(f[idx.INTPTLAT]), lng: Number(f[idx.INTPTLONG]) };
    if (byKey.has(key)) ambiguous.add(key);
    byKey.set(key, place);
  }
  for (const key of ambiguous) byKey.delete(key);
  return { places: Object.fromEntries([...byKey].sort(([a], [b]) => a.localeCompare(b))), ambiguous: [...ambiguous].sort() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`Census returned ${res.status}`);
  const { places, ambiguous } = parseGazetteer(await res.text());
  await writeFile(OUT, JSON.stringify({ source: SOURCE, places }, null, 0) + '\n');
  console.log(`Wrote ${Object.keys(places).length} places; left out ambiguous names: ${ambiguous.join(', ') || 'none'}`);
}
