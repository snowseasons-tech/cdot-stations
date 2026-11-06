import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeFeed, run } from '../scripts/sync-work-zones.js';

// A small WZDx-shaped feed: a point, a line and a zone with no location.
const sample = {
  type: 'FeatureCollection',
  features: [
    { id: 'a', type: 'Feature', geometry: { type: 'Point', coordinates: [-105.2, 39.7] },
      properties: { road_event_id: 'RE-1', event_status: 'active', start_date: '2026-11-01T00:00:00Z', end_date: '2026-11-30T00:00:00Z',
        core_details: { event_type: 'work-zone', road_names: ['I-70'], direction: 'eastbound', description: 'Lane closed' } } },
    { id: 'b', type: 'Feature', geometry: { type: 'LineString', coordinates: [[-105.0, 39.8], [-105.2, 39.6]] },
      properties: { road_event_id: 'RE-2', event_status: 'planned', core_details: { event_type: 'work-zone', road_names: ['US-6'] } } },
    { id: 'c', type: 'Feature', geometry: null, properties: { road_event_id: 'RE-3', core_details: {} } },
  ],
};

const RESPONSE_OK = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test('the feed is turned into one placed zone per location, with its roads and times', () => {
  const out = normalizeFeed(sample, '2026-11-06T12:00:00.000Z');
  assert.equal(out.zones.length, 2, 'the zone without a location is left out');
  assert.deepEqual(out.zones[0], {
    id: 'RE-1', lat: 39.7, lng: -105.2, roads: ['I-70'], direction: 'eastbound', eventType: 'work-zone',
    description: 'Lane closed', status: 'active', start: '2026-11-01T00:00:00Z', end: '2026-11-30T00:00:00Z',
  });
  assert.deepEqual([out.zones[1].lat, out.zones[1].lng], [39.7, -105.1], 'a line is placed at the middle of its points');
  assert.equal(out.fetchedAt, '2026-11-06T12:00:00.000Z');
});

test('a document that is not a WZDx feed is refused', () => {
  assert.throws(() => normalizeFeed({ hello: 'world' }, 'x'), /not a WZDx FeatureCollection/);
  assert.throws(() => normalizeFeed(null, 'x'), /not a WZDx FeatureCollection/);
});

test('without WZDX_FEED_URL nothing is fetched', async () => {
  const result = await run({ env: {}, fetchImpl: () => { throw new Error('must not fetch'); } });
  assert.deepEqual(result, { status: 'not-configured' });
});

test('a failed feed is reported without its URL, so the key is never shown', async () => {
  const secret = 'https://example.test/feed?apiKey=TOP-SECRET-KEY';
  const result = await run({ env: { WZDX_FEED_URL: secret }, fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /401/);
  assert.ok(!JSON.stringify(result).includes('TOP-SECRET-KEY'));
});

test('a configured run writes the zones, reports unchanged on a repeat, and keeps the last zones if the feed comes back empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'work-zones-'));
  const out = new URL(`file://${join(dir, 'work-zones.json')}`);
  try {
    const env = { WZDX_FEED_URL: 'https://example.test/feed?apiKey=k' };
    assert.equal((await run({ env, fetchImpl: RESPONSE_OK(sample), out, now: () => '2026-11-06T12:00:00.000Z' })).status, 'updated');
    assert.equal(JSON.parse(await readFile(out, 'utf8')).zones.length, 2);
    assert.equal((await run({ env, fetchImpl: RESPONSE_OK(sample), out, now: () => '2026-11-06T12:05:00.000Z' })).status, 'unchanged');
    const empty = await run({ env, fetchImpl: RESPONSE_OK({ type: 'FeatureCollection', features: [] }), out });
    assert.equal(empty.status, 'failed');
    assert.equal(JSON.parse(await readFile(out, 'utf8')).zones.length, 2, 'the last good zones are kept');
  } finally {
    await rm(dir, { recursive: true });
  }
});
