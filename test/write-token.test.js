import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';

// The phone and desktop save path sends `Authorization: Bearer <STATUS_TOKEN>` (see public/app.js, the save handler).
// These pin what the server accepts for that header, so a change to the token check cannot quietly loosen it.
async function start(t, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-token-'));
  const server = await createApp({ statusFile: join(dir, 'status.json'), ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true }); });
  return { base };
}

const save = (base, headers = {}) =>
  fetch(`${base}/api/stations/limon/status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ status: 'open', note: 'phone check' }),
  });

test('a save without a token is refused and changes nothing', async (t) => {
  const { base } = await start(t, { token: 'secret' });
  assert.equal((await save(base)).status, 401);
  const { stations } = await (await fetch(`${base}/api/stations`)).json();
  assert.equal(stations.find((s) => s.id === 'limon').status, 'unknown');
});

test('a save with the right token is accepted, and the same save with a wrong one is refused', async (t) => {
  const { base } = await start(t, { token: 'secret' });
  assert.equal((await save(base, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await save(base, { authorization: 'Bearer secret' })).status, 200);
});

test('only the Bearer scheme with the exact token is accepted', async (t) => {
  const { base } = await start(t, { token: 'secret' });
  for (const authorization of ['Basic secret', 'bearer secret', 'Bearer', 'secret']) {
    assert.equal((await save(base, { authorization })).status, 401, `refused: "${authorization}"`);
  }
  assert.equal((await save(base, { authorization: 'Bearer secret' })).status, 200);
});

test('an empty token in the form is treated as no token', async (t) => {
  const { base } = await start(t, { token: 'secret' });
  // The save handler only sends the header when the field has a value, so an empty field sends no header at all.
  assert.equal((await save(base, {})).status, 401);
});

test('the token is never echoed back in a response', async (t) => {
  const { base } = await start(t, { token: 'secret' });
  const refused = await save(base, { authorization: 'Bearer wrong' });
  assert.doesNotMatch(await refused.text(), /secret|wrong/);
  const accepted = await save(base, { authorization: 'Bearer secret' });
  assert.doesNotMatch(await accepted.text(), /secret/);
});
