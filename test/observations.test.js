import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { STALE_MS } from '../observations.js';

const key = 'test-workspace-access-key-00000000';
const observedAt = '2025-01-01T12:00:00.000Z';
const sample = { lat: 39.74, lng: -104.99, roadway: 'I-70', direction: 'eastbound', status: 'active', observedAt, notes: 'Test observation' };

test('observations require a dedicated key and stay separate from station data', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-observations-'));
  const servers = [];
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(dir, { recursive: true, force: true });
  });
  let now = Date.parse(observedAt) + 60_000;
  async function start(observationToken) {
    const server = await createApp({
      statusFile: join(dir, 'status.json'),
      token: 'different-status-token',
      observationToken,
      observationNow: () => now,
    });
    servers.push(server);
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    return (path = '', method = 'GET', body, token = key) => fetch(base + '/api/observations' + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const disabled = await start(undefined);
  assert.equal((await disabled()).status, 503);
  const api = await start(key);
  assert.equal((await api('', 'GET', undefined, '')).status, 401);
  assert.equal((await api('', 'POST', sample, 'different-status-token')).status, 401);
  assert.equal((await api('', 'POST', { ...sample, lat: 36 })).status, 400);
  assert.equal((await api('', 'POST', { ...sample, observedAt: '2099-01-01' })).status, 400);
  const creation = await api('', 'POST', { ...sample, source: 'official' });
  assert.equal(creation.status, 201);
  const report = await creation.json();
  assert.equal(report.source, 'user-reported');
  assert.equal(report.stale, false);
  now = Date.parse(observedAt) + STALE_MS;
  const restarted = await start(key);
  const listing = await restarted();
  assert.equal(listing.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await listing.json()).reports, [{ ...report, stale: true }]);

  const url = '/' + report.id;
  const edit = { ...sample, lat: 39.75, status: 'inactive', revision: report.revision };
  const simultaneous = await Promise.all([
    restarted(url, 'PUT', edit),
    restarted(url, 'PUT', { ...edit, lat: 39.76 }),
  ]);
  assert.deepEqual(simultaneous.map((response) => response.status).sort(), [200, 409]);
  const updated = await simultaneous.find((response) => response.ok).json();
  assert.equal(updated.status, 'inactive');
  assert.equal((await restarted(url, 'DELETE', { revision: report.revision })).status, 409);
  assert.equal((await restarted(url, 'DELETE', { revision: updated.revision }, '')).status, 401);
  assert.equal((await restarted(url, 'DELETE', { revision: updated.revision })).status, 200);
  assert.deepEqual((await (await restarted()).json()).reports, []);
});
