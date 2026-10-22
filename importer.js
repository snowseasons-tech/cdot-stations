// Applies externally sourced status records (from a CSP/COtrip/Drivewyze adapter, a CSV, a script...)
// to the store. A record is { station, status, note?, updatedAt? } where `station` is a station id or name.
import { STATUSES } from './store.js';

const ALIASES = { opened: 'open', close: 'closed', '': 'unknown' };
const CLOCK_SKEW_MS = 5 * 60_000;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function normalizeStatus(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  const status = ALIASES[v] ?? v;
  return STATUSES.includes(status) ? status : null;
}

export async function importStatuses(store, stations, records, { source }) {
  const result = { updated: [], unchanged: [], skipped: [] };
  const skip = (record, reason) => result.skipped.push({ record, reason });
  const byId = new Map(stations.map((s) => [s.id, s]));

  for (const record of records) {
    const station = byId.get(slug(record?.station ?? ''));
    if (!station) { skip(record, 'unknown station'); continue; }
    if (station.planned) { skip(record, 'station is not open yet'); continue; }
    const status = normalizeStatus(record.status);
    if (!status) { skip(record, `unrecognized status "${record.status}"`); continue; }

    let updatedAt = new Date().toISOString();
    if (record.updatedAt) {
      const t = new Date(record.updatedAt);
      if (Number.isNaN(t.getTime())) { skip(record, 'invalid updatedAt'); continue; }
      if (t - Date.now() > CLOCK_SKEW_MS) { skip(record, 'updatedAt is in the future'); continue; }
      updatedAt = t.toISOString();
    }

    const current = store.get(station.id);
    if (current.updatedAt && updatedAt < current.updatedAt) { skip(record, 'older than current status'); continue; }
    const note = String(record.note ?? '').trim();
    if (current.status === status && current.note === note && current.source === source) { result.unchanged.push(station.id); continue; }

    try {
      await store.set(station.id, { status, note, source, updatedAt });
      result.updated.push(station.id);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      skip(record, e.message);
    }
  }
  return result;
}
