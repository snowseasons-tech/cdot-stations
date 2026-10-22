import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const read = (p) => readFile(new URL(`../public/${p}`, import.meta.url), 'utf8');

async function helpers() {
  const sandbox = { window: {}, URLSearchParams };
  vm.runInNewContext(await read('links.js'), sandbox);
  return sandbox.window.conditionsLinks;
}

test('cotripMapUrl opens COtrip on a point with the five useful layers on', async () => {
  const { cotripMapUrl, LAYERS } = await helpers();
  assert.equal(
    cotripMapUrl({ lat: 39.273475, lng: -103.686262 }),
    'https://www.cotrip.org/?lat=39.2735&lng=-103.6863&zoom=11&layers=traffic_incidents%2Cclosures%2Cconstruction%2Cweather_alerts%2Cweather_radar',
  );
  assert.deepEqual([...LAYERS], ['traffic_incidents', 'closures', 'construction', 'weather_alerts', 'weather_radar']);
  assert.match(cotripMapUrl({ lat: 37.1368, lng: -104.5203 }, 9), /lat=37\.1368&lng=-104\.5203&zoom=9&/);
  const url = new URL(cotripMapUrl({ lat: 39.1, lng: -108.8 }));
  assert.equal(url.searchParams.get('layers').split(',').length, 5); // the comma survives encoding and decoding
});

test('every external link in the page is new-tab, noopener, https, and goes to a site we meant to link', async () => {
  const html = await read('index.html');
  const anchors = [...html.matchAll(/<a\s[^>]*href="(https?:[^"]+)"[^>]*>/g)];
  const allowed = new Set(['www.cotrip.org', 'apps.apple.com', 'play.google.com', 'x.com']);
  const hosts = new Set();
  for (const [tag, href] of anchors) {
    const url = new URL(href);
    assert.equal(url.protocol, 'https:', href);
    assert.ok(allowed.has(url.hostname), `unexpected link target ${url.hostname}`);
    assert.match(tag, /target="_blank"/, href);
    assert.match(tag, /rel="noopener noreferrer"/, href);
    hosts.add(url.hostname);
  }
  assert.deepEqual([...hosts].sort(), ['apps.apple.com', 'play.google.com', 'www.cotrip.org', 'x.com']); // each resource is present

  // the exact addresses, as confirmed from COtrip's own site and CDOT's
  for (const href of [
    'https://www.cotrip.org/',
    'https://apps.apple.com/us/app/cotrip-planner/id1582530559',
    'https://play.google.com/store/apps/details?id=crc.oneapp.co',
    'https://x.com/ColoradoDOT',
  ]) assert.ok(html.includes(`href="${href}"`), href);
  assert.match(html, /<details id="conditions"/);
});

test('links the page builds in script open a new tab safely, and use the shared URL builder', async () => {
  const js = await read('app.js');
  assert.equal((js.match(/target: '_blank'/g) ?? []).length, (js.match(/rel: 'noopener noreferrer'/g) ?? []).length);
  assert.ok((js.match(/target: '_blank'/g) ?? []).length >= 2, 'a link on the station card and one in the popup');
  assert.ok(!/href: [`'"]https?:/.test(js), 'no hand-written external addresses in script: use conditionsLinks.cotripMapUrl'); // tel: links are fine
  const html = await read('index.html');
  assert.ok(html.indexOf('src="links.js"') !== -1 && html.indexOf('src="links.js"') < html.indexOf('src="app.js"')); // loaded first
});
