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
export const EXPORT_MAX = 10_000;
const EXPORT_TIMEOUT_MS = 25_000;
const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 200;
const TIMEOUT_MS = 8_000;
const COLUMNS = [
  'inspection_id', 'insp_date', 'insp_start_time', 'location_desc', 'insp_level_id', 'viol_total', 'oos_total',
  'vehicle_oos_total', 'driver_oos_total', 'hazmat_oos_total', 'insp_carrier_name', 'insp_carrier_city',
  'insp_carrier_state', 'dot_number',
];

// Out-of-service filter: a fixed list, each mapped to the column it tests (never built from input).
const OOS_COLUMNS = { any: 'oos_total', vehicle: 'vehicle_oos_total', driver: 'driver_oos_total' };

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
  // Levels I-V as "1,3" (any order). Nothing, or all five, means no level filter.
  const lv = params.get('levels') ?? '';
  let levels = '';
  if (lv) {
    if (!/^[1-5](,[1-5]){0,4}$/.test(lv)) throw new SearchError('levels must be a comma-separated list of 1-5');
    const set = [...new Set(lv.split(','))].sort();
    levels = set.length === 5 ? '' : set.join(',');
  }
  const oos = params.get('oos') ?? '';
  if (oos && !Object.hasOwn(OOS_COLUMNS, oos)) throw new SearchError('oos must be any, vehicle or driver');
  // The carrier's state, province or territory: FMCSA's two-letter code.
  const state = (params.get('state') ?? '').trim().toUpperCase();
  if (state && !/^[A-Z]{2}$/.test(state)) throw new SearchError('state must be a two-letter code such as TX');
  const raw = params.get('offset') ?? '0';
  if (!/^\d{1,4}$/.test(raw)) throw new SearchError(`offset must be a whole number from 0 to ${MAX_OFFSET}`);
  const offset = Number(raw);
  if (offset > MAX_OFFSET || offset % PAGE_SIZE !== 0) throw new SearchError(`offset must be a multiple of ${PAGE_SIZE} up to ${MAX_OFFSET}`);
  if (!q && !from && !to && !state && !levels && !oos) throw new SearchError('enter a place or carrier, a date range, or choose a filter');
  return { q, from, to, levels, oos, state, offset };
}

const quote = (s) => `'${s.replaceAll("'", "''")}'`;

export function buildUrl({ q, from, to, levels = '', oos = '', state = '', offset }, limit = PAGE_SIZE + 1) {
  const where = ["report_state='CO'", "insp_facility='F'"];
  if (q) where.push(`(upper(location_desc) like ${quote(`%${q}%`)} OR upper(insp_carrier_name) like ${quote(`%${q}%`)})`);
  if (from) where.push(`insp_date >= ${quote(from.replaceAll('-', ''))}`);
  if (to) where.push(`insp_date <= ${quote(to.replaceAll('-', ''))}`);
  if (levels) where.push(`insp_level_id in(${levels.split(',').map((l) => quote(l)).join(',')})`);
  if (oos) where.push(`${OOS_COLUMNS[oos]} != '0'`);
  if (state) where.push(`insp_carrier_state = ${quote(state)}`);
  const url = new URL(ENDPOINT);
  url.searchParams.set('$select', COLUMNS.join(','));
  url.searchParams.set('$where', where.join(' AND '));
  url.searchParams.set('$order', 'insp_date DESC, insp_start_time DESC, inspection_id DESC');
  url.searchParams.set('$limit', String(limit)); // one extra row tells us whether there is another page
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
    const key = `${search.q}|${search.from}|${search.to}|${search.levels}|${search.oos}|${search.state}|${search.offset}`;
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

const COLUMNS_OUT = [
  ['Date', (r) => r.date], ['Time', (r) => r.time], ['Place', (r) => r.place], ['Level', (r) => r.level],
  ['Level name', (r) => r.levelName], ['Violations', (r) => r.violations], ['Out of service', (r) => r.oos.total],
  ['Vehicle OOS', (r) => r.oos.vehicle], ['Driver OOS', (r) => r.oos.driver], ['Hazmat OOS', (r) => r.oos.hazmat],
  ['Carrier', (r) => r.carrier], ['City', (r) => r.city], ['State', (r) => r.state], ['DOT number', (r) => r.dot],
  ['Inspection ID', (r) => r.id],
];

// One CSV cell. Text starting with = + - @ (or a tab/CR) would be run as a formula by Excel and Sheets, and carrier
// names are other people's text, so those get a leading apostrophe. Quotes are doubled and the cell is quoted.
const cell = (v) => {
  let t = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return `"${t.replaceAll('"', '""')}"`;
};

export const toCsv = (rows) => '\ufeff' + [COLUMNS_OUT.map(([name]) => cell(name)).join(','), ...rows.map((r) => COLUMNS_OUT.map(([, get]) => cell(get(r))).join(','))].join('\r\n') + '\r\n'; // BOM so Excel reads UTF-8

// Every match (newest first), up to EXPORT_MAX, as shaped rows. `truncated` says there were more than that.
export async function exportAll(search, { fetchImpl = fetch } = {}) {
  let rows;
  try {
    const res = await fetchImpl(buildUrl({ ...search, offset: 0 }, EXPORT_MAX + 1), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS) });
    if (!res.ok) throw new Error('bad status');
    rows = await res.json();
    if (!Array.isArray(rows)) throw new Error('bad shape');
  } catch {
    throw new Error('upstream');
  }
  return { results: rows.slice(0, EXPORT_MAX).map(shape), truncated: rows.length > EXPORT_MAX };
}

// ---- MySQL dump -------------------------------------------------------------------------------------------------
// A .sql file that creates an `inspections` table (if it isn't there) and loads the rows with REPLACE INTO, so loading
// the same export twice, or an overlapping one later, updates rows instead of duplicating them.
// Text goes in as a quoted literal built here: backslash, quote and control characters are escaped, and the file turns
// off NO_BACKSLASH_ESCAPES for its own session so that escaping means the same thing wherever it is loaded.
const sqlText = (v, max) => {
  if (v === null || v === undefined || v === '') return 'NULL';
  const t = String(v).slice(0, max)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')   // no control characters at all (newlines, NUL, Ctrl-Z, ...)
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "''");
  return `'${t}'`;
};
const sqlInt = (v) => String(Number.isSafeInteger(v) && v >= 0 ? v : 0);
const sqlDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v ?? '') ? `'${v}'` : 'NULL');
const sqlTime = (v) => (/^\d{2}:\d{2}$/.test(v ?? '') && Number(v.slice(0, 2)) < 24 && Number(v.slice(3)) < 60 ? `'${v}:00'` : 'NULL');
const sqlRow = (r) => `(${[
  sqlText(r.id, 20), sqlDate(r.date), sqlTime(r.time), sqlText(r.place, 80), sqlText(r.level, 1), sqlText(r.levelName, 40),
  sqlInt(r.violations), sqlInt(r.oos.total), sqlInt(r.oos.vehicle), sqlInt(r.oos.driver), sqlInt(r.oos.hazmat),
  sqlText(r.carrier, 80), sqlText(r.city, 80), sqlText(r.state, 2), sqlText(r.dot, 10),
].join(', ')})`;

const SQL_BATCH = 500;
export const toSql = (rows, { generatedAt = new Date() } = {}) => {
  const out = [
    `-- CDOT inspection stations: Colorado fixed-port inspections from FMCSA's Vehicle Inspection File`,
    `-- ${rows.length} row${rows.length === 1 ? '' : 's'}, exported ${generatedAt.toISOString()}. Load with: mysql your_database < this_file.sql`,
    `SET NAMES utf8mb4;`,
    `SET SESSION sql_mode = REPLACE(@@sql_mode, 'NO_BACKSLASH_ESCAPES', '');`,
    `CREATE TABLE IF NOT EXISTS inspections (`,
    `  inspection_id VARCHAR(20) NOT NULL PRIMARY KEY,`,
    `  inspected_on DATE NULL,`,
    `  inspected_at TIME NULL,`,
    `  place VARCHAR(80) NULL,`,
    `  level CHAR(1) NULL,`,
    `  level_name VARCHAR(40) NULL,`,
    `  violations INT UNSIGNED NOT NULL DEFAULT 0,`,
    `  oos_total INT UNSIGNED NOT NULL DEFAULT 0,`,
    `  oos_vehicle INT UNSIGNED NOT NULL DEFAULT 0,`,
    `  oos_driver INT UNSIGNED NOT NULL DEFAULT 0,`,
    `  oos_hazmat INT UNSIGNED NOT NULL DEFAULT 0,`,
    `  carrier VARCHAR(80) NULL,`,
    `  city VARCHAR(80) NULL,`,
    `  state CHAR(2) NULL,`,
    `  dot_number VARCHAR(10) NULL,`,
    `  KEY (inspected_on), KEY (place), KEY (dot_number)`,
    `) DEFAULT CHARSET=utf8mb4;`,
  ];
  const usable = rows.filter((r) => /^\d{1,20}$/.test(r.id ?? '')); // the primary key must be present
  for (let i = 0; i < usable.length; i += SQL_BATCH) {
    out.push('REPLACE INTO inspections (inspection_id, inspected_on, inspected_at, place, level, level_name, violations, oos_total, oos_vehicle, oos_driver, oos_hazmat, carrier, city, state, dot_number) VALUES');
    out.push(usable.slice(i, i + SQL_BATCH).map(sqlRow).join(',\n') + ';');
  }
  return out.join('\n') + '\n';
};
