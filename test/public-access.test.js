import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;

// A fake "public hostname" that answers every request with the given status and Location.
async function fakeSite(t, status, location) {
  const server = createServer((req, res) => {
    res.writeHead(status, location ? { location } : {});
    res.end('{"stations":[]}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
// Must be async: the fake site runs in this process, so a blocking spawn would stop it from ever answering.
const check = (url) => new Promise((resolve) => {
  execFile('bash', ['scripts/check-public-access.sh', url], { cwd: ROOT, encoding: 'utf8' }, (error, stdout, stderr) =>
    resolve({ status: error ? error.code : 0, stdout, stderr }));
});

test('passes when visitors are redirected to the Access sign-in', async (t) => {
  const r = await check(await fakeSite(t, 302, 'https://team.cloudflareaccess.com/cdn-cgi/access/login/stations.example.net'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PASS/);
});

test('passes when Access blocks with 401 or 403', async (t) => {
  assert.equal((await check(await fakeSite(t, 403))).status, 0);
  assert.equal((await check(await fakeSite(t, 401))).status, 0);
});

test('FAILS loudly when the app answers without a sign-in', async (t) => {
  const r = await check(await fakeSite(t, 200));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /open to the internet/);
});

test('cannot tell (exit 2) for a redirect elsewhere, a missing route, or an unreachable host', async (t) => {
  assert.equal((await check(await fakeSite(t, 302, 'https://example.com/login'))).status, 2);
  assert.equal((await check(await fakeSite(t, 404))).status, 2);
  assert.equal((await check(await fakeSite(t, 530))).status, 2);
  assert.equal((await check('http://127.0.0.1:1')).status, 2);
});
