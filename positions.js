// Saved positions for stations that have moved. CDOT's layer is the starting point (and is refreshed weekly), but
// ports do get relocated; a team member who has seen it can save the new position here. A saved position replaces the
// pin on the map, CDOT's original is kept and shown, every save is recorded, and a save can be reverted.
// Stored apart from data/stations.json so the weekly refresh can never overwrite it.
import { readFile } from 'node:fs/promises';
import { AtomicWriter } from './atomic-writer.js';
import { distanceMiles, inColorado } from './geo.js';

export const MAX_NOTE = 280;
export const MAX_MOVE_MILES = 100; // further than this from CDOT's position is almost certainly a typo
const AGREES_WITHIN_MILES = 0.05;  // about 80 m: CDOT's own position has caught up with the saved one
const MAX_HISTORY = 1000;
const round6 = (n) => Math.round(n * 1e6) / 1e6; // about 10 cm; keeps the files tidy

// Checks a request body { lat, lng, note? } against CDOT's position for that pin. Throws RangeError with a message that
// is safe to show to the person.
export function validatePosition(body, original) {
  const { lat, lng } = body ?? {};
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new RangeError('lat and lng must be numbers');
  }
  const position = { lat: round6(lat), lng: round6(lng) };
  if (!inColorado(position)) throw new RangeError('that position is outside Colorado; check the latitude and longitude (longitude is negative)');
  const miles = distanceMiles(original, position);
  if (miles > MAX_MOVE_MILES) throw new RangeError(`that is ${Math.round(miles)} miles from CDOT's position; check the coordinates (the limit is ${MAX_MOVE_MILES} miles)`);
  const note = body.note ?? '';
  if (typeof note !== 'string' || note.length > MAX_NOTE) throw new RangeError(`note must be text up to ${MAX_NOTE} characters`);
  return { ...position, note: note.trim() };
}

// Whether CDOT's own position has caught up with a saved one, so the saved one is no longer needed.
export const agrees = (original, saved) => distanceMiles(original, saved) <= AGREES_WITHIN_MILES;

export class Positions {
  constructor(file) {
    this.file = file;
    this.state = { positions: {}, history: [] };
    this.writer = new AtomicWriter(file);
  }

  async load() {
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  static key(stationId, direction) { return `${stationId}:${direction}`; }
  get(stationId, direction) { return this.state.positions[Positions.key(stationId, direction)] ?? null; }
  history(stationId) { return this.state.history.filter((h) => h.station === stationId).slice(-50).reverse(); }
  save() { return this.writer.save(() => this.state); }

  record(entry) {
    this.state.history.push(entry);
    this.state.history = this.state.history.slice(-MAX_HISTORY);
  }

  // Saves `position` ({ lat, lng, note }, already validated) for one direction's pin. `original` is CDOT's position.
  async set(stationId, direction, position, original) {
    const key = Positions.key(stationId, direction);
    const previous = this.state.positions[key] ?? original;
    const entry = { ...position, savedAt: new Date().toISOString(), source: 'manual' };
    this.state.positions[key] = entry;
    this.record({ station: stationId, direction, action: 'move', lat: entry.lat, lng: entry.lng, note: entry.note, previous: { lat: previous.lat, lng: previous.lng }, savedAt: entry.savedAt });
    await this.save();
    return entry;
  }

  // Puts the pin back to CDOT's position. Returns false if it had not been moved.
  async revert(stationId, direction, original) {
    const key = Positions.key(stationId, direction);
    const current = this.state.positions[key];
    if (!current) return false;
    delete this.state.positions[key];
    this.record({ station: stationId, direction, action: 'revert', lat: original.lat, lng: original.lng, note: '', previous: { lat: current.lat, lng: current.lng }, savedAt: new Date().toISOString() });
    await this.save();
    return true;
  }
}
