import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';

// The history cap is global: the last 1000 changes across all stations are kept, not 1000 per station. This pins that
// behavior, so a busy station can push a quiet station's history out. If the cap becomes per station, change this test.
test('history keeps the last 1000 changes across all stations, so a busy station can evict a quiet one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-history-'));
  t.after(() => rm(dir, { recursive: true }));
  const store = new Store(join(dir, 'status.json'));
  await store.load();

  await store.set('quiet', { status: 'open', note: 'only change' });
  assert.equal(store.history('quiet').length, 1);

  for (let i = 0; i < 1000; i++) {
    await store.set('busy', { status: i % 2 ? 'open' : 'closed', note: `change ${i}` });
  }

  assert.equal(store.state.history.length, 1000);
  assert.equal(store.history('quiet').length, 0);
  assert.equal(store.history('busy').length, 50); // the endpoint still returns the newest 50 for a station
});
