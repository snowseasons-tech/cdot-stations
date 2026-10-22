// Status storage: data/status.json holds the current status per station plus an append-only history.
import { readFile, writeFile, rename } from 'node:fs/promises';

export const STATUSES = ['open', 'closed', 'unknown'];
const MAX_NOTE = 280;
const MAX_HISTORY = 1000;

export class Store {
  constructor(file) {
    this.file = file;
    this.state = { current: {}, history: [] };
  }

  async load() {
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  get(id) {
    return this.state.current[id] ?? { status: 'unknown', note: '', updatedAt: null };
  }

  history(id) {
    return this.state.history.filter((h) => h.id === id).slice(-50).reverse();
  }

  async set(id, { status, note = '' }) {
    if (!STATUSES.includes(status)) throw new RangeError(`status must be one of ${STATUSES.join(', ')}`);
    if (typeof note !== 'string' || note.length > MAX_NOTE) throw new RangeError(`note must be a string up to ${MAX_NOTE} characters`);
    const entry = { status, note: note.trim(), updatedAt: new Date().toISOString() };
    this.state.current[id] = entry;
    this.state.history.push({ id, ...entry });
    this.state.history = this.state.history.slice(-MAX_HISTORY);
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.file);
    return entry;
  }
}
