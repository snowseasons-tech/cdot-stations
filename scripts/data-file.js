// Shared by the sync scripts: reads the previous data file and only rewrites it when the data itself
// changed (the fetchedAt timestamp alone doesn't count), so scheduled refreshes don't create empty commits.
import { readFile, writeFile } from 'node:fs/promises';

const withoutTimestamp = ({ fetchedAt, ...rest }) => JSON.stringify(rest);

export async function readPrevious(url) {
  try {
    return JSON.parse(await readFile(url, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Returns true if the file was written.
export async function writeIfChanged(url, previous, next, indent) {
  if (previous && withoutTimestamp(previous) === withoutTimestamp(next)) return false;
  await writeFile(url, JSON.stringify(next, null, indent) + '\n');
  return true;
}
