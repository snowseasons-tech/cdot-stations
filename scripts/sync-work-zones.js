// Pulls a CDOT work zone feed in the WZDx format (Work Zone Data Exchange) and writes the active and planned
// zones to data/work-zones.json, one point per zone, for the stations page to use.
//
// The feed is CDOT's, published through COtrip, and it needs an API key. Nothing is fetched unless
// WZDX_FEED_URL is set, and that URL (which contains the key) is never printed or written to the repo.
// Use this only with CDOT's permission and the key they issue; see README, "Conditions inside the page".
import { readPrevious, writeIfChanged } from './data-file.js';

export const OUT = new URL('../data/work-zones.json', import.meta.url);
const MAX_ZONES = 5000;
const TIMEOUT_MS = 20000;

// Some publishers serialise WZDx keys as camelCase (coreDetails, eventType). Their feeds are still WZDx, so the
// keys are converted to snake_case first. This follows streetworks (the MIT Python SDK for WZDx), which does the same.
const snakeKey = (key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
export function snakeKeys(object) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return object;
  return Object.fromEntries(Object.entries(object).map(([k, v]) => [snakeKey(k), v]));
}

// The middle of a zone's geometry: the average of its points (one point for a Point, all of them for a line).
function centre(geometry) {
  if (!geometry) return null;
  let points;
  if (geometry.type === 'Point') points = [geometry.coordinates];
  else if (geometry.type === 'MultiPoint' || geometry.type === 'LineString') points = geometry.coordinates;
  else if (geometry.type === 'MultiLineString') points = geometry.coordinates.flat();
  else return null;
  const valid = points.filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  if (!valid.length) return null;
  const lon = valid.reduce((sum, p) => sum + p[0], 0) / valid.length;
  const lat = valid.reduce((sum, p) => sum + p[1], 0) / valid.length;
  return { lat: Number(lat.toFixed(6)), lng: Number(lon.toFixed(6)) };
}

// Turns a WZDx feed into the zones the page needs. Throws if the document is not a WZDx feed.
export function normalizeFeed(feed, fetchedAt) {
  if (!feed || feed.type !== 'FeatureCollection' || !Array.isArray(feed.features)) {
    throw new Error('the feed is not a WZDx FeatureCollection');
  }
  const zones = [];
  let incidents = 0;
  for (const f of feed.features) {
    const where = centre(f.geometry);
    if (!where) continue;   // a zone without a usable location cannot be placed on the page
    const p = snakeKeys(f.properties) || {};
    const core = snakeKeys(p.core_details) || {};
    // Only work zones are published. A WZDx feed can also carry incidents and other road events.
    if (core.event_type !== 'work-zone') { incidents++; continue; }
    zones.push({
      id: String(p.road_event_id ?? f.id ?? zones.length),
      lat: where.lat,
      lng: where.lng,
      roads: Array.isArray(core.road_names) ? core.road_names.map(String) : [],
      direction: core.direction ? String(core.direction) : '',
      eventType: core.event_type ? String(core.event_type) : '',
      description: core.description ? String(core.description) : '',
      status: p.event_status ? String(p.event_status) : '',
      start: p.start_date ? String(p.start_date) : null,
      end: p.end_date ? String(p.end_date) : null,
    });
  }
  if (zones.length > MAX_ZONES) throw new Error(`the feed has more than ${MAX_ZONES} zones; refusing to publish it`);
  return { source: 'CDOT work zone feed (WZDx, via COtrip)', fetchedAt, zones, skippedNonWorkZones: incidents };
}

// Runs the sync. Returns what happened, so the tests and the CLI can report it without the URL.
export async function run({ env = process.env, fetchImpl = fetch, out = OUT, now = () => new Date().toISOString() } = {}) {
  const url = env.WZDX_FEED_URL;
  if (!url) return { status: 'not-configured' };
  let body;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return { status: 'failed', reason: `the feed answered ${response.status}` };
    body = await response.json();
  } catch (error) {
    return { status: 'failed', reason: error.name === 'TimeoutError' ? 'the feed timed out' : 'the feed could not be read' };
  }
  let next;
  try {
    next = normalizeFeed(body, now());
  } catch (error) {
    return { status: 'failed', reason: error.message };
  }
  const previous = await readPrevious(out);
  // An empty feed after a non-empty one is more likely a broken feed than a county with no work zones.
  if (next.zones.length === 0 && previous?.zones?.length > 0) {
    return { status: 'failed', reason: 'the feed is empty but the last one had zones; keeping the last one' };
  }
  const written = await writeIfChanged(out, previous, next);
  return { status: written ? 'updated' : 'unchanged', zones: next.zones.length };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const result = await run();
  if (result.status === 'not-configured') {
    console.log('Work zones: WZDX_FEED_URL is not set, so nothing was fetched. Set it to the feed CDOT has authorised.');
  } else if (result.status === 'failed') {
    console.error(`Work zones: not updated (${result.reason}).`);
    process.exitCode = 1;
  } else {
    console.log(`Work zones: ${result.status}, ${result.zones} zone(s).`);
  }
}
