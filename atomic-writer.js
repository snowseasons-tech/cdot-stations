// Saves JSON state to a file safely: write a temp file, then rename it over the real one, so a crash can't leave a
// half-written file. Writes run one at a time (they share the temp file, so overlapping ones would race on the
// rename), each saving the state as it is when its turn comes, and a failed write doesn't block the ones behind it.
import { writeFile, rename } from 'node:fs/promises';

export class AtomicWriter {
  constructor(file) {
    this.file = file;
    this.queue = Promise.resolve();
  }

  // `snapshot` is called when the write actually runs, so queued writes always save the latest state.
  save(snapshot) {
    const write = this.queue.then(async () => {
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(snapshot(), null, 2));
      await rename(tmp, this.file);
    });
    this.queue = write.catch(() => {});
    return write;
  }
}
