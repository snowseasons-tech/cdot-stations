import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { parseWriteTokens } from '../auth.js';
import { Store } from '../store.js';

// WRITE_TOKENS gives each person their own bearer token; the person's name is then recorded on every
// status change and history entry, which is the audit trail the roadmap asks for. The single shared
// STATUS_TOKEN keeps working exactly as before (no author recorded).

async function start(t, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-author-'));
  const server = await createApp({ statusFile: join(dir, 'status.json'), ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true }); });
  return base;
}

const save = (base, headers = {}, station = 'limon') =>
  fetch(`${base}/api/stations/${station}/status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ status: 'open', note: 'no wait' }),
  });

const writeTokens = () => new Map(Object.entries({ alice: 'token-for-alice', bob: 'token-for-bob' }));

test('a personal token records who made the change, on the status and in the history', async (t) => {
  const base = await start(t, { token: 'shared-secret', writeTokens: writeTokens() });
  assert.equal((await save(base, { authorization: 'Bearer token-for-alice' })).status, 200);
  const station = await (await fetch(`${base}/api/stations/limon`)).json();
  assert.equal(station.author, 'alice');
  assert.equal((await save(base, { authorization: 'Bearer token-for-bob' })).status, 200);
  const history = await (await fetch(`${base}/api/stations/limon/history`)).json();
  assert.deepEqual(history.map((h) => h.author), ['bob', 'alice']);
});

test('the shared token keeps working and records no author', async (t) => {
  const base = await start(t, { token: 'shared-secret', writeTokens: writeTokens() });
  assert.equal((await save(base, { authorization: 'Bearer shared-secret' })).status, 200);
  const station = await (await fetch(`${base}/api/stations/limon`)).json();
  assert.equal(station.author, null);
});

test('an unknown token is refused, and personal tokens share the lockout with the shared one', async (t) => {
  const base = await start(t, { token: 'shared-secret', writeTokens: writeTokens() });
  assert.equal((await save(base, { authorization: 'Bearer token-for-carol' })).status, 401);
  assert.equal((await save(base, { authorization: 'Bearer token-for-alice' })).status, 200);
  // Ten failures lock the client out, whatever token they were aimed at: Carol's counts as one, so nine more.
  for (let i = 0; i < 9; i++) assert.equal((await save(base, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await save(base, { authorization: 'Bearer token-for-alice' })).status, 429);
});

test('an import with a personal token records who ran it; the source stays the feed', async (t) => {
  const base = await start(t, { token: 'shared-secret', writeTokens: writeTokens() });
  const res = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer token-for-bob' },
    body: JSON.stringify({ source: 'cotrip', records: [{ station: 'limon', status: 'closed' }] }),
  });
  assert.equal(res.status, 200);
  const station = await (await fetch(`${base}/api/stations/limon`)).json();
  assert.equal(station.source, 'cotrip');
  assert.equal(station.author, 'bob');
});

test('personal tokens also unlock the members endpoints', async (t) => {
  const base = await start(t, { token: 'shared-secret', writeTokens: writeTokens() });
  const ok = await fetch(`${base}/api/members`, { headers: { authorization: 'Bearer token-for-alice' } });
  assert.equal(ok.status, 200);
  const refused = await fetch(`${base}/api/members`, { headers: { authorization: 'Bearer nope-token' } });
  assert.equal(refused.status, 401);
});

test('personal tokens alone are enough (no STATUS_TOKEN)', async (t) => {
  const base = await start(t, { writeTokens: writeTokens() });
  assert.equal((await save(base)).status, 401);
  assert.equal((await save(base, { authorization: 'Bearer token-for-alice' })).status, 200);
});

test('parseWriteTokens accepts a name->token object and rejects anything else', () => {
  const tokens = parseWriteTokens('{"alice":"token-for-alice","Bob C":"another-token"}');
  assert.equal(tokens.get('alice'), 'token-for-alice');
  assert.equal(tokens.get('Bob C'), 'another-token');
  assert.equal(parseWriteTokens('').size, 0);
  assert.equal(parseWriteTokens(undefined).size, 0);
  for (const bad of ['{', '[]', '"alice"', '{"alice":1}', '{"alice":"short"}', '{"bad name!":"token-for-x"}', '{"alice":""}']) {
    assert.throws(() => parseWriteTokens(bad), Error, `rejects: ${bad}`);
  }
});

test('the store rejects a malformed author and trims nothing else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-store-'));
  const store = new Store(join(dir, 'status.json'));
  await store.load();
  const entry = await store.set('limon', { status: 'open', author: 'alice' });
  assert.equal(entry.author, 'alice');
  await assert.rejects(store.set('limon', { status: 'open', author: 'a'.repeat(41) }), RangeError);
  await assert.rejects(store.set('limon', { status: 'open', author: 5 }), RangeError);
  await rm(dir, { recursive: true });
});
