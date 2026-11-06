import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

// Fake curl (prints a body and exits with a code) and fake gh (logs its arguments; `issue list` answers the open issue).
async function sandbox(t, { body = '{"stations":[]}', curlCode = 0, openIssue = '' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-health-'));
  t.after(() => rm(dir, { recursive: true }));
  await writeFile(join(dir, 'curl-body'), body);
  await writeFile(join(dir, 'curl-code'), String(curlCode));
  await writeFile(join(dir, 'issue'), openIssue);
  await writeFile(join(dir, 'curl'), `#!/usr/bin/env bash
cat "${dir}/curl-body"
exit "$(cat "${dir}/curl-code")"
`);
  await writeFile(join(dir, 'gh'), `#!/usr/bin/env bash
echo "gh $*" >> "${dir}/calls"
if [ "$1 $2" = "issue list" ]; then cat "${dir}/issue"; fi
exit 0
`);
  await chmod(join(dir, 'curl'), 0o755);
  await chmod(join(dir, 'gh'), 0o755);
  const calls = async () => (await readFile(join(dir, 'calls'), 'utf8').catch(() => ''));
  return { dir, calls };
}

const probe = (dir) =>
  spawnSync('bash', ['scripts/site-health-check.sh'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, TMPDIR: dir, APP_URL: 'http://127.0.0.1:9', ALERT_REPO: 'o/r' },
  });

test('a healthy API with no open issue reports OK and opens nothing', async (t) => {
  const { dir, calls } = await sandbox(t);
  const r = probe(dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /site health: OK/);
  const log = await calls();
  assert.doesNotMatch(log, /issue (create|comment|close)/);
});

test('an unreachable API opens one site-down issue and exits with the curl error', async (t) => {
  const { dir, calls } = await sandbox(t, { body: '', curlCode: 7 });
  const r = probe(dir);
  assert.equal(r.status, 7);
  assert.match(r.stdout, /site health: FAIL/);
  const log = await calls();
  assert.match(log, /issue create -R o\/r -l site-down/);
  assert.doesNotMatch(log, /issue comment/);
});

test('a second failure adds a comment to the open issue instead of opening another', async (t) => {
  const { dir, calls } = await sandbox(t, { body: '', curlCode: 28, openIssue: '7\n' });
  const r = probe(dir);
  assert.equal(r.status, 28);
  const log = await calls();
  assert.match(log, /issue comment 7 -R o\/r/);
  assert.doesNotMatch(log, /issue create/);
});

test('recovery comments on and closes the open issue', async (t) => {
  const { dir, calls } = await sandbox(t, { openIssue: '7\n' });
  const r = probe(dir);
  assert.equal(r.status, 0);
  const log = await calls();
  assert.match(log, /issue comment 7 -R o\/r -b Recovered/);
  assert.match(log, /issue close 7 -R o\/r/);
});

test('a 200 response that is not the stations object counts as down', async (t) => {
  const { dir, calls } = await sandbox(t, { body: '<html>maintenance</html>' });
  const r = probe(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /site health: FAIL/);
  assert.match(await calls(), /issue create/);
});

test('a stations field that is not an array counts as down', async (t) => {
  const { dir } = await sandbox(t, { body: '{"stations":{}}' });
  const r = probe(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /site health: FAIL/);
});
