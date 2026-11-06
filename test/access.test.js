import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { createApp } from '../server.js';
import { loadAccessConfig, createAccessVerifier, isPublicAddress, requiresAccess } from '../access.js';

// Cloudflare Access verification at the origin: when configured, a request that came through the tunnel
// must carry a valid Cf-Access-Jwt-Assertion. These tests run the real server with injected keys, so no
// network or Cloudflare account is involved.

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });
const JWKS = { keys: [{ ...jwk, kid: 'test-key', alg: 'ES256', use: 'sig' }] };
const accessFetch = async (url) => {
  if (url !== 'https://testteam.cloudflareaccess.com/cdn-cgi/access/certs') throw new Error(`unexpected fetch: ${url}`);
  return { ok: true, json: async () => JWKS };
};
const config = () => ({ team: 'testteam', aud: 'aaaaaaaaaaaaaaaa' });

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload, { kid = 'test-key', key = privateKey } = {}) => {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid }));
  const body = b64url(JSON.stringify(payload));
  const signature = createSign('SHA256').update(`${header}.${body}`).sign(key);
  return `${header}.${body}.${b64url(signature)}`;
};
const validPayload = (over = {}) => ({ iss: 'https://testteam.cloudflareaccess.com', aud: 'aaaaaaaaaaaaaaaa', sub: 'user-1', email: 'someone@example.com', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...over });

async function start(t, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-access-'));
  const server = await createApp({ statusFile: join(dir, 'status.json'), accessConfig: config(), accessFetch, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true }); });
  return base;
}

const get = (base, headers) => fetch(`${base}/api/stations`, { headers });

test('a tunnel request with a valid Access JWT is served', async (t) => {
  const base = await start(t, { trustProxy: true });
  const res = await get(base, { 'x-real-ip': '203.0.113.5', 'cf-access-jwt-assertion': sign(validPayload()) });
  assert.equal(res.status, 200);
});

test('a tunnel request without a sign-in, or with a bad one, is refused', async (t) => {
  const base = await start(t, { trustProxy: true });
  assert.equal((await get(base, { 'x-real-ip': '203.0.113.5' })).status, 401);
  assert.equal((await get(base, { 'x-real-ip': '203.0.113.5', 'cf-access-jwt-assertion': 'not-a-jwt' })).status, 401);
  assert.equal((await get(base, { 'x-real-ip': '203.0.113.5', 'cf-access-jwt-assertion': sign(validPayload({ aud: 'wrong-aud' })) })).status, 401);
  assert.equal((await get(base, { 'x-real-ip': '203.0.113.5', 'cf-access-jwt-assertion': sign(validPayload({ exp: Math.floor(Date.now() / 1000) - 7200 })) })).status, 401);
  assert.equal((await get(base, { 'x-real-ip': '203.0.113.5', 'cf-access-jwt-assertion': sign(validPayload({ iss: 'https://otherteam.cloudflareaccess.com' })) })).status, 401);
  // signed by the wrong key
  const stranger = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  assert.equal((await get(base, { 'x-real-ip': '203.0.113.5', 'cf-access-jwt-assertion': sign(validPayload(), { key: stranger.privateKey }) })).status, 401);
  // unknown key id
  assert.equal((await get(base, { 'x-real-ip': '203.0.113.5', 'cf-access-jwt-assertion': sign(validPayload(), { kid: 'other-key' }) })).status, 401);
});

test('LAN visitors and the container health check are exempt', async (t) => {
  const base = await start(t, { trustProxy: true });
  assert.equal((await get(base, { 'x-real-ip': '192.168.0.5' })).status, 200);
  assert.equal((await get(base, {})).status, 200); // no proxy header at all
});

test('without TRUST_PROXY the visitor address is not trusted, so nothing is required', async (t) => {
  const base = await start(t, { trustProxy: false });
  assert.equal((await get(base, { 'x-real-ip': '203.0.113.5' })).status, 200);
});

test('verification is off unless the env configures it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-noaccess-'));
  const server = await createApp({ statusFile: join(dir, 'status.json') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true }); });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/stations`, { headers: { 'x-real-ip': '203.0.113.5' } });
  assert.equal(res.status, 200);
});

test('loadAccessConfig needs both values and validates them', () => {
  assert.equal(loadAccessConfig({}), null);
  assert.deepEqual(loadAccessConfig({ ACCESS_TEAM: 'team', ACCESS_AUD: 'a'.repeat(32) }), { team: 'team', aud: 'a'.repeat(32) });
  assert.throws(() => loadAccessConfig({ ACCESS_TEAM: 'team' }), /both/);
  assert.throws(() => loadAccessConfig({ ACCESS_AUD: 'a'.repeat(32) }), /both/);
  assert.throws(() => loadAccessConfig({ ACCESS_TEAM: 'bad team!', ACCESS_AUD: 'a'.repeat(32) }), Error);
  assert.throws(() => loadAccessConfig({ ACCESS_TEAM: 'team', ACCESS_AUD: 'not-hex' }), Error);
});

test('isPublicAddress tells tunnel visitors from home-network ones', () => {
  for (const lan of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.20', '::1', 'fd00::1', 'fe80::1', 'not-an-ip', '']) {
    assert.equal(isPublicAddress(lan), false, lan);
  }
  for (const wan of ['203.0.113.5', '8.8.8.8', '172.32.0.1', '2600:1f00::1', '::ffff:203.0.113.5']) {
    assert.equal(isPublicAddress(wan), true, wan);
  }
  assert.equal(isPublicAddress('::ffff:192.168.0.5'), false);
});

test('requiresAccess reads the proxy-reported address only when it is trusted', () => {
  const tunnel = { headers: { 'x-real-ip': '203.0.113.5' } };
  const lan = { headers: { 'x-real-ip': '192.168.0.5' } };
  assert.equal(requiresAccess(tunnel, { trustProxy: true }), true);
  assert.equal(requiresAccess(tunnel, { trustProxy: false }), false);
  assert.equal(requiresAccess(lan, { trustProxy: true }), false);
  assert.equal(requiresAccess({ headers: {} }, { trustProxy: true }), false);
});

test('the verifier itself checks the claims', async () => {
  const verify = createAccessVerifier({ config: config(), fetchImpl: accessFetch });
  assert.equal(await verify({ headers: { 'cf-access-jwt-assertion': sign(validPayload()) } }), true);
  assert.equal(await verify({ headers: {} }), false);
  assert.equal(await verify({ headers: { 'cf-access-jwt-assertion': sign(validPayload({ exp: Math.floor(Date.now() / 1000) + 3600 * 24 * 400 })) } }), true); // long-lived token, still valid now
  // nbf in the future
  assert.equal(await verify({ headers: { 'cf-access-jwt-assertion': sign(validPayload({ nbf: Math.floor(Date.now() / 1000) + 600 })) } }), false);
});
