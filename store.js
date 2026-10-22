// Status storage: data/status.json holds the current status per station plus an append-only history.
import { readFile } from 'node:fs/promises';
import { AtomicWriter } from './atomic-writer.js';

export const STATUSES = ['open', 'closed', 'unknown'];
const MAX_NOTE = 280;
const MAX_HISTORY = 1000;

export class Store {
  // onChange({ id, previous, current }) is called after a change to a station's status or note has been saved
  // (not for a repeat of what is already stored), so something like push notifications can react to it.
  constructor(file, { onChange } = {}) {
    this.file = file;
    this.onChange = onChange;
    this.state = { current: {}, history: [] };
    this.writer = new AtomicWriter(file);
  }

  async load() {
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  get(id) {
    return this.state.current[id] ?? { status: 'unknown', note: '', updatedAt: null, source: null };
  }

  history(id) {
    return this.state.history.filter((h) => h.id === id).slice(-50).reverse();
  }

  async set(id, { status, note = '', source = 'manual', updatedAt = new Date().toISOString() }) {
    if (!STATUSES.includes(status)) throw new RangeError(`status must be one of ${STATUSES.join(', ')}`);
    if (typeof note !== 'string' || note.length > MAX_NOTE) throw new RangeError(`note must be a string up to ${MAX_NOTE} characters`);
    const entry = { status, note: note.trim(), updatedAt, source };
    const previous = this.get(id);
    this.state.current[id] = entry;
    this.state.history.push({ id, ...entry });
    this.state.history = this.state.history.slice(-MAX_HISTORY);
    await this.save();
    if (this.onChange && (previous.status !== entry.status || previous.note !== entry.note)) {
      try { this.onChange({ id, previous, current: entry }); } catch (e) { console.error('onChange failed:', e.message); } // never fails the write
    }
    return entry;
  }

  save() {
    return this.writer.save(() => this.state);
  }
}
