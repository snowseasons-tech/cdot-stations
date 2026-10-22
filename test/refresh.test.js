import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPrevious, writeIfChanged } from '../scripts/data-file.js';
import { removedStations } from '../scripts/sync-stations.js';
import { shrankTooMuch } from '../scripts/sync-inspections.js';

async function tmpFile(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-'));
  t.after(() => rm(dir, { recursive: true }));
  return pathToFileURL(join(dir, 'data.json'));
}

test('writeIfChanged ignores fetchedAt but writes real changes', async (t) => {
  const url = await tmpFile(t);
  assert.equal(await readPrevious(url), null);

  const first = { fetchedAt: '2026-01-01', rows: [1, 2] };
  assert.equal(await writeIfChanged(url, null, first, 2), true);

  const previous = await readPrevious(url);
  assert.equal(await writeIfChanged(url, previous, { fetchedAt: '2026-02-02', rows: [1, 2] }, 2), false);
  assert.equal(JSON.parse(await readFile(url, 'utf8')).fetchedAt, '2026-01-01'); // untouched

  assert.equal(await writeIfChanged(url, previous, { fetchedAt: '2026-02-02', rows: [1, 2, 3] }, 2), true);
  assert.deepEqual(JSON.parse(await readFile(url, 'utf8')).rows, [1, 2, 3]);
});

test('removedStations flags stations that disappeared, not new ones', () => {
  const prev = { stations: [{ id: 'limon' }, { id: 'cortez' }] };
  assert.deepEqual(removedStations(prev, [{ id: 'limon' }, { id: 'new-port' }]), ['cortez']);
  assert.deepEqual(removedStations(prev, [{ id: 'limon' }, { id: 'cortez' }, { id: 'new-port' }]), []);
  assert.deepEqual(removedStations(null, [{ id: 'limon' }]), []);
});

test('shrankTooMuch tolerates rolling-window trimming but not a bad fetch', () => {
  const rows = (n) => [{ total: n }];
  assert.equal(shrankTooMuch(rows(1000), rows(900)), false); // 10% older months dropped off
  assert.equal(shrankTooMuch(rows(1000), rows(1200)), false);
  assert.equal(shrankTooMuch(rows(1000), rows(700)), true); // 30% gone
  assert.equal(shrankTooMuch(rows(1000), []), true);
  assert.equal(shrankTooMuch(undefined, rows(5)), false); // first ever sync
});
