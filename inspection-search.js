// Search of individual Colorado fixed-site inspections, answered live from FMCSA's public Vehicle Inspection File
// (Socrata dataset fx4q-ay7w). Nothing is stored: a search is validated, turned into one fixed-shape query, and the
// answer is cached briefly.
//
// What reaches the query from a caller: a text term (letters, digits, space and . & ' -), two dates and an offset.
// The host, the dataset, the columns and the filters are constants, and the term is only ever placed inside a quoted
// string with its quotes doubled, so a caller can't change what is asked for.
import { LEVELS } from './inspections.js';

const ENDPOINT = 'https://data.transportation.gov/resource/fx4q-ay7w.json';
export const PAGE_SIZE = 50;
export const MAX_OFFSET = 1000;
const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 200;
const TIMEOUT_MS = 8_000;
const COLUMNS = [
  'inspection_id', 'insp_date', 'insp_start_time', 'location_desc', 'insp_level_id', 'viol_total', 'oos_total',
  'vehicle_oos_total', 'driver_oos_total', 'hazmat_oos_total', 'insp_carrier_name', 'insp_carrier_city',
  'insp_carrier_state', 'dot_number',
];

export class SearchError extends Error {}

const isDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '2000-01-01';
};

// params: anything with .get(name) (URLSearchParams). Returns a normalised search, or throws SearchError.
export function parseSearch(params) {
  const q = (params.get('q') ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (q && (q.length < 2 || q.length > 40 || !/^[A-Z0-9 .&'-]+$/.test(q))) {
    throw new SearchError("q must be 2-40 characters: letters, digits, spaces and . & ' -");
  }
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  if (from && !isDate(from)) throw new SearchError('from must be a date like 2026-01-31');
  if (to && !isDate(to)) throw new SearchError('to must be a date like 2026-01-31');
  if (from && to && to < from) throw new SearchError('to must not be before from');
  const raw = params.get('offset') ?? '0';
  if (!/^\d{1,4}$/.test(raw)) throw new SearchError(`offset must be a whole number from 0 to ${MAX_OFFSET}`);
  const offset = Number(raw);
  if (offset > MAX_OFFSET || offset % PAGE_SIZE !== 0) throw new SearchError(`offset must be a multiple of ${PAGE_SIZE} up to ${MAX_OFFSET}`);
  if (!q && !from && !to) throw new SearchError('enter a place or carrier, or a date range');
  return { q, from, to, offset };
}

const quote = (s) => `'${s.replaceAll("'", "''")}'`;

export function buildUrl({ q, from, to, offset }) {
  const where = ["report_state='CO'", "insp_facility='F'"];
  if (q) where.push(`(upper(location_desc) like ${quote(`%${q}%`)} OR upper(insp_carrier_name) like ${quote(`%${q}%`)})`);
  if (from) where.push(`insp_date >= ${quote(from.replaceAll('-', ''))}`);
  if (to) where.push(`insp_date <= ${quote(to.replaceAll('-', ''))}`);
  const url = new URL(ENDPOINT);
  url.searchParams.set('$select', COLUMNS.join(','));
  url.searchParams.set('$where', where.join(' AND '));
  url.searchParams.set('$order', 'insp_date DESC, insp_start_time DESC, inspection_id DESC');
  url.searchParams.set('$limit', String(PAGE_SIZE + 1)); // one extra row tells us whether there is another page
  url.searchParams.set('$offset', String(offset));
  return url;
}

const count = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const text = (v, max = 80) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const day = (v) => (/^\d{8}$/.test(v ?? '') ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}` : null);
const clock = (v) => (/^\d{4}$/.test(v ?? '') ? `${v.slice(0, 2)}:${v.slice(2)}` : null);

export function shape(row) {
  const level = text(row.insp_level_id, 2);
  return {
    id: text(row.inspection_id, 20),
    date: day(row.insp_date),
    time: clock(row.insp_start_time),
    place: text(row.location_desc),
    level,
    levelName: LEVELS[level] ?? 'Other',
    violations: count(row.viol_total),
    oos: { total: count(row.oos_total), vehicle: count(row.vehicle_oos_total), driver: count(row.driver_oos_total), hazmat: count(row.hazmat_oos_total) },
    carrier: text(row.insp_carrier_name),
    city: text(row.insp_carrier_city),
    state: text(row.insp_carrier_state, 2),
    dot: text(row.dot_number, 10),
  };
}

// createSearcher({ fetchImpl, now }) -> async (search) => { results, hasMore, offset, pageSize }
// Failures of any kind surface as one generic Error('upstream'), so nothing from the other service reaches a caller.
export function createSearcher({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map();
  return async (search) => {
    const key = `${search.q}|${search.from}|${search.to}|${search.offset}`;
    const hit = cache.get(key);
    if (hit && hit.expires > now()) {
      cache.delete(key);
      cache.set(key, hit); // most recently used goes last
      return hit.value;
    }
    let rows;
    try {
      const res = await fetchImpl(buildUrl(search), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error('bad status');
      rows = await res.json();
      if (!Array.isArray(rows)) throw new Error('bad shape');
    } catch {
      throw new Error('upstream');
    }
    const value = { results: rows.slice(0, PAGE_SIZE).map(shape), hasMore: rows.length > PAGE_SIZE, offset: search.offset, pageSize: PAGE_SIZE };
    cache.set(key, { value, expires: now() + CACHE_MS });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return value;
  };
}
