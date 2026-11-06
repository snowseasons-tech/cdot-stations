import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const MARK = '# cdot-stations site health';

// A fake crontab that keeps the table in a file, so the installer can be run against a temporary table. The installer
// reads the table and writes the new one in one pipeline, so the fake writes a temporary file and renames it: a plain
// redirect would empty the file while `crontab -l` is still reading it.
async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-cron-'));
  t.after(() => rm(dir, { recursive: true }));
  await writeFile(join(dir, 'crontab.txt'), '');
  await writeFile(join(dir, 'crontab'), `#!/usr/bin/env bash
if [ "$1" = "-l" ]; then cat "${dir}/crontab.txt"; exit 0; fi
cat > "${dir}/crontab.next" && mv "${dir}/crontab.next" "${dir}/crontab.txt"
`);
  await chmod(join(dir, 'crontab'), 0o755);
  return { dir, table: () => readFile(join(dir, 'crontab.txt'), 'utf8') };
}

const install = (dir, args = []) =>
  spawnSync('bash', ['scripts/install-health-check-cron.sh', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir },
  });

test('the installer adds one five-minute entry that runs the probe and logs to the home folder', async (t) => {
  const { dir, table } = await sandbox(t);
  const r = install(dir);
  assert.equal(r.status, 0, r.stderr);
  const lines = (await table()).split('\n').filter((l) => l.includes(MARK));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\*\/5 \* \* \* \* cd '.*' && APP_URL=http:\/\/127\.0\.0\.1:8080 bash scripts\/site-health-check\.sh >> \$HOME\/cdot-stations\/site-health\.log 2>&1 # cdot-stations site health$/);
});

test('running the installer again replaces the entry instead of adding a second one', async (t) => {
  const { dir, table } = await sandbox(t);
  install(dir);
  install(dir);
  const lines = (await table()).split('\n').filter((l) => l.includes(MARK));
  assert.equal(lines.length, 1);
});

test('a custom schedule and URL are written, and other crontab lines are kept', async (t) => {
  const { dir, table } = await sandbox(t);
  await writeFile(join(dir, 'crontab.txt'), '0 3 * * * /usr/bin/something-else\n');
  const r = install(dir, ['0 * * * *', 'http://example.test:9000']);
  assert.equal(r.status, 0, r.stderr);
  const text = await table();
  assert.match(text, /^0 3 \* \* \* \/usr\/bin\/something-else$/m);
  assert.match(text, /^0 \* \* \* \* cd .* APP_URL=http:\/\/example\.test:9000 bash scripts\/site-health-check\.sh/m);
});
