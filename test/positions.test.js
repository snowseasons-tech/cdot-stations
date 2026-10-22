import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { distanceMiles, inColorado, centroid } from '../geo.js';
import { Positions, validatePosition, agrees, MAX_MOVE_MILES } from '../positions.js';

const LIMON = { lat: 39.2735, lng: -103.6859 };

async function store(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-'));
  t.after(() => rm(dir, { recursive: true }));
  const file = join(dir, 'positions.json');
  const positions = new Positions(file);
  await positions.load();
  return { positions, file };
}

test('distanceMiles is right for known distances, and zero for the same point', () => {
  assert.equal(distanceMiles(LIMON, LIMON), 0);
  const denverToColoradoSprings = distanceMiles({ lat: 39.7392, lng: -104.9903 }, { lat: 38.8339, lng: -104.8214 });
  assert.ok(denverToColoradoSprings > 62 && denverToColoradoSprings < 66, String(denverToColoradoSprings)); // about 63 road-free miles
  const oneDegreeOfLatitude = distanceMiles({ lat: 39, lng: -105 }, { lat: 40, lng: -105 });
  assert.ok(Math.abs(oneDegreeOfLatitude - 69) < 0.5, String(oneDegreeOfLatitude));
});

test('inColorado accepts the state and rejects the usual typing mistakes', () => {
  assert.equal(inColorado(LIMON), true);
  assert.equal(inColorado({ lat: 39.74, lng: -104.99 }), true);                  // Denver
  assert.equal(inColorado({ lat: -103.6859, lng: 39.2735 }), false);             // latitude and longitude swapped
  assert.equal(inColorado({ lat: 39.2735, lng: 103.6859 }), false);              // missing minus sign
  assert.equal(inColorado({ lat: 39.2735, lng: -13.6859 }), false);              // dropped digit
  assert.equal(inColorado({ lat: 35.1, lng: -106 }), false);                     // New Mexico
});

test('centroid averages points', () => {
  assert.deepEqual(centroid([{ lat: 10, lng: -100 }, { lat: 20, lng: -110 }]), { lat: 15, lng: -105 });
});

test('validatePosition accepts a nearby position, rounds it, trims the note, and rejects bad input with a clear message', () => {
  const ok = validatePosition({ lat: 39.27500123456789, lng: -103.68, note: '  moved to the new building  ' }, LIMON);
  assert.deepEqual(ok, { lat: 39.275001, lng: -103.68, note: 'moved to the new building' });
  assert.equal(validatePosition({ lat: 39.28, lng: -103.69 }, LIMON).note, ''); // the note is optional

  const bad = (body, pattern) => assert.throws(() => validatePosition(body, LIMON), (e) => e instanceof RangeError && pattern.test(e.message), JSON.stringify(body));
  bad({}, /numbers/);
  bad(undefined, /numbers/);
  bad({ lat: '39.28', lng: -103.69 }, /numbers/);                  // text, not a number
  bad({ lat: null, lng: -103.69 }, /numbers/);
  bad({ lat: Number.NaN, lng: -103.69 }, /numbers/);
  bad({ lat: Infinity, lng: -103.69 }, /numbers/);
  bad({ lat: -103.69, lng: 39.28 }, /outside Colorado/);           // swapped
  bad({ lat: 39.28, lng: 103.69 }, /outside Colorado/);            // no minus sign
  bad({ lat: 37.5, lng: -103.69 }, new RegExp(`miles from CDOT's position.*${MAX_MOVE_MILES}`)); // inside Colorado but about 122 miles away
  assert.equal(validatePosition({ lat: 38.0, lng: -103.69 }, LIMON).lat, 38); // about 88 miles: under the limit, so it is allowed
  bad({ lat: 39.28, lng: -103.69, note: 'x'.repeat(281) }, /280/);
  bad({ lat: 39.28, lng: -103.69, note: 42 }, /280/);
});

test('a position over the distance limit is refused even though it is inside Colorado', () => {
  const farButInColorado = { lat: 37.2, lng: -108.0 };            // Durango area: ~320 miles from Limon
  assert.ok(inColorado(farButInColorado));
  assert.throws(() => validatePosition(farButInColorado, LIMON), /miles from CDOT's position/);
});

test('agrees is true only when CDOT has caught up within about 80 m', () => {
  assert.equal(agrees(LIMON, { lat: 39.2736, lng: -103.6859 }), true);   // about 11 m
  assert.equal(agrees(LIMON, { lat: 39.2800, lng: -103.6859 }), false);  // about 0.45 miles
});

test('a position is saved with its history, survives a restart, and can be reverted', async (t) => {
  const { positions, file } = await store(t);
  assert.equal(positions.get('limon', 'WB'), null);

  const entry = await positions.set('limon', 'WB', { lat: 39.275, lng: -103.68, note: 'new building' }, LIMON);
  assert.deepEqual([entry.lat, entry.lng, entry.note, entry.source], [39.275, -103.68, 'new building', 'manual']);
  assert.ok(Date.parse(entry.savedAt) > Date.now() - 5000);
  assert.equal(positions.get('limon', 'EB'), null);                      // the other direction is untouched

  await positions.set('limon', 'WB', { lat: 39.276, lng: -103.679, note: 'moved again' }, LIMON);
  const reloaded = new Positions(file);
  await reloaded.load();
  assert.deepEqual([reloaded.get('limon', 'WB').lat, reloaded.get('limon', 'WB').note], [39.276, 'moved again']);

  const history = reloaded.history('limon');
  assert.deepEqual(history.map((h) => [h.action, h.lat]), [['move', 39.276], ['move', 39.275]]); // newest first
  assert.deepEqual(history[1].previous, { lat: LIMON.lat, lng: LIMON.lng });                       // the first save moved it from CDOT's position
  assert.deepEqual(history[0].previous, { lat: 39.275, lng: -103.68 });                            // the second from the first save

  assert.equal(await reloaded.revert('limon', 'WB', LIMON), true);
  assert.equal(reloaded.get('limon', 'WB'), null);
  assert.equal(reloaded.history('limon')[0].action, 'revert');
  assert.deepEqual([reloaded.history('limon')[0].lat, reloaded.history('limon')[0].lng], [LIMON.lat, LIMON.lng]);
  assert.equal(await reloaded.revert('limon', 'WB', LIMON), false);      // nothing left to revert
  assert.equal(reloaded.history('cortez').length, 0);                    // history is per station
});

test('the history keeps only the most recent entries', async (t) => {
  const { positions } = await store(t);
  for (let i = 0; i < 1005; i++) positions.record({ station: 'limon', direction: 'WB', action: 'move', lat: 39, lng: -104, note: '', previous: LIMON, savedAt: `t${i}` });
  assert.equal(positions.state.history.length, 1000);
  assert.equal(positions.history('limon').length, 50);                   // and reading returns at most the latest 50
});
