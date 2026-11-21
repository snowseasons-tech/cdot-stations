import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AtomicWriter } from './atomic-writer.js';

export const STALE_MS = 24 * 60 * 60 * 1000;
const STATUSES = ['active', 'inactive', 'unknown'];
const DIRECTIONS = ['northbound', 'southbound', 'eastbound', 'westbound', 'both', 'unknown'];

export function observationFields(input, now) {
  const { lat, lng, observedAt, status, direction, roadway, notes } = input ?? {};
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 37 || lat > 41 || lng < -109.06 || lng > -102.04) {
    throw new RangeError('Place the pin within Colorado.');
  }
  const observed = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN;
  if (!Number.isFinite(observed) || observed > now) throw new RangeError('Enter an observation time in the past.');
  if (!STATUSES.includes(status) || !DIRECTIONS.includes(direction)) throw new RangeError('Choose a status and direction.');
  if (typeof roadway !== 'string' || !roadway.trim() || roadway.length > 80) throw new RangeError('Enter a roadway up to 80 characters.');
  if (typeof notes !== 'string' || notes.length > 1000) throw new RangeError('Use up to 1,000 characters for notes.');
  return { lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)), observedAt: new Date(observed).toISOString(),
    status, direction, roadway: roadway.trim(), notes: notes.trim(), source: 'user-reported' };
}

export async function openObservations(file, now = Date.now) {
  let reports;
  try {
    reports = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    reports = [];
  }
  const writer = new AtomicWriter(file);
  let pending = Promise.resolve();
  const view = (report) => ({ ...report, stale: now() - Date.parse(report.observedAt) >= STALE_MS });
  return {
    list: () => reports.map(view).sort((a, b) => b.observedAt.localeCompare(a.observedAt)),
    change(id, method, body) {
      const result = pending.then(async () => {
        const previous = reports.find((report) => report.id === id);
        if (id && !previous) return null;
        const next = reports.filter((report) => report.id !== id);
        let saved;
        if (method !== 'DELETE') {
          if (!id && next.length >= 5000) throw new RangeError('Observation limit reached. Delete old observations to make room.');
          saved = { ...observationFields(body, now()), id: id ?? randomUUID(), revision: randomUUID() };
          next.push(saved);
        }
        if (previous && body.revision !== previous.revision) return false;
        await writer.save(() => next);
        reports = next;
        return saved ? view(saved) : true;
      });
      pending = result.catch(() => {});
      return result;
    },
  };
}
