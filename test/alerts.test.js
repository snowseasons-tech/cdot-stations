import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

// A fake `gh` that logs its arguments and answers `issue list` from a state file.
async function sandbox(t, { openIssue = '' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cdot-'));
  t.after(() => rm(dir, { recursive: true }));
  await writeFile(join(dir, 'issue'), openIssue);
  await writeFile(join(dir, 'gh'), `#!/usr/bin/env bash
echo "gh $*" >> "${dir}/calls"
if [ "$1 $2" = "issue list" ]; then cat "${dir}/issue"; fi
exit 0
`);
  await chmod(join(dir, 'gh'), 0o755);
  const calls = async () => (await readFile(join(dir, 'calls'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { dir, calls };
}

const run = (dir, script, env, cwd = ROOT) =>
  spawnSync('bash', [script], { cwd, encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, ...env } });

test('a failed backup opens an issue and keeps the failing exit code', async (t) => {
  const { dir, calls } = await sandbox(t);
  const r = run(dir, 'scripts/backup-run.sh', { BACKUP_CMD: 'bash -c "echo boom >&2; exit 3"', ALERT_REPO: 'o/r' });
  assert.equal(r.status, 3);
  assert.match(r.stdout, /boom/);
  const c = await calls();
  assert.ok(c.some((l) => l.startsWith('gh label create backup-failed')));
  const create = c.find((l) => l.startsWith('gh issue create'));
  assert.ok(create && create.includes('-R o/r') && create.includes('-l backup-failed'));
});

test('a failure while an issue is already open comments instead of opening another', async (t) => {
  const { dir, calls } = await sandbox(t, { openIssue: '7' });
  run(dir, 'scripts/backup-run.sh', { BACKUP_CMD: 'false', ALERT_REPO: 'o/r' });
  const c = await calls();
  assert.ok(c.some((l) => l.startsWith('gh issue comment 7')));
  assert.ok(!c.some((l) => l.startsWith('gh issue create')));
});

test('success closes an open failure issue, and is silent otherwise', async (t) => {
  const open = await sandbox(t, { openIssue: '7' });
  assert.equal(run(open.dir, 'scripts/backup-run.sh', { BACKUP_CMD: 'true', ALERT_REPO: 'o/r' }).status, 0);
  const c = await open.calls();
  assert.ok(c.some((l) => l.startsWith('gh issue comment 7') && l.includes('Recovered')));
  assert.ok(c.some((l) => l.startsWith('gh issue close 7')));

  const none = await sandbox(t);
  run(none.dir, 'scripts/backup-run.sh', { BACKUP_CMD: 'true', ALERT_REPO: 'o/r' });
  assert.deepEqual((await none.calls()).filter((l) => !l.startsWith('gh issue list')), []);
});

test('recovery closes every open failure issue, not just the first', async (t) => {
  const { dir, calls } = await sandbox(t, { openIssue: '7\n9' });
  run(dir, 'scripts/backup-run.sh', { BACKUP_CMD: 'true', ALERT_REPO: 'o/r' });
  const c = await calls();
  for (const n of ['7', '9']) assert.ok(c.some((l) => l.startsWith(`gh issue close ${n}`)), `issue ${n} should be closed`);
});

test('alerts can be disabled and a broken gh never changes the backup result', async (t) => {
  const { dir, calls } = await sandbox(t);
  assert.equal(run(dir, 'scripts/backup-run.sh', { BACKUP_CMD: 'false', ALERT_REPO: '' }).status, 1);
  assert.deepEqual(await calls(), []);

  await writeFile(join(dir, 'gh'), '#!/usr/bin/env bash\nexit 1\n'); // gh fails every call
  assert.equal(run(dir, 'scripts/backup-run.sh', { BACKUP_CMD: 'false', ALERT_REPO: 'o/r' }).status, 1);
  assert.equal(run(dir, 'scripts/backup-run.sh', { BACKUP_CMD: 'true', ALERT_REPO: 'o/r' }).status, 0);
});

// heartbeat check, run inside a temp "backup repo" checkout
async function backupRepo(t, heartbeat) {
  const s = await sandbox(t);
  const repo = join(s.dir, 'repo');
  const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  spawnSync('git', ['init', '-q', repo]);
  await writeFile(join(repo, 'README'), 'x');
  git('add', '.'); git('commit', '-qm', 'init');
  if (heartbeat) await writeFile(join(repo, 'heartbeat.txt'), heartbeat + '\n');
  return { ...s, repo };
}
const check = (s, nowIso, env = {}) =>
  run(s.dir, join(ROOT, 'deploy/backup-repo/scripts/check-heartbeat.sh'), { GH_REPO: 'o/r', NOW_EPOCH: String(Date.parse(nowIso) / 1000), ...env }, s.repo);

test('heartbeat check: fresh is quiet, stale opens an issue, recovery closes it', async (t) => {
  const fresh = await backupRepo(t, '2026-10-22T09:30:00Z');
  assert.match(check(fresh, '2026-10-23T09:30:00Z').stdout, /^OK: 24h/); // 24h < 30h limit
  assert.deepEqual((await fresh.calls()).filter((l) => !l.startsWith('gh issue list')), []);

  const stale = await backupRepo(t, '2026-10-22T09:30:00Z');
  assert.match(check(stale, '2026-10-24T12:00:00Z').stdout, /^STALE: 50h/);
  const c = await stale.calls();
  assert.ok(c.some((l) => l.startsWith('gh issue create') && l.includes('backup-missing')));

  const alreadyOpen = await backupRepo(t, '2026-10-22T09:30:00Z');
  await writeFile(join(alreadyOpen.dir, 'issue'), '4');
  check(alreadyOpen, '2026-10-24T12:00:00Z');
  const c2 = await alreadyOpen.calls();
  assert.ok(c2.some((l) => l.startsWith('gh issue comment 4')) && !c2.some((l) => l.startsWith('gh issue create')));

  const recovered = await backupRepo(t, '2026-10-24T09:30:00Z');
  await writeFile(join(recovered.dir, 'issue'), '4');
  check(recovered, '2026-10-24T12:00:00Z');
  assert.ok((await recovered.calls()).some((l) => l.startsWith('gh issue close 4')));
});

test('heartbeat check: before any heartbeat, a longer grace period applies', async (t) => {
  const s = await backupRepo(t, null);
  const created = Math.floor(Date.now() / 1000);
  assert.match(run(s.dir, join(ROOT, 'deploy/backup-repo/scripts/check-heartbeat.sh'), { GH_REPO: 'o/r', NOW_EPOCH: String(created + 48 * 3600) }, s.repo).stdout, /^OK/);
  assert.match(run(s.dir, join(ROOT, 'deploy/backup-repo/scripts/check-heartbeat.sh'), { GH_REPO: 'o/r', NOW_EPOCH: String(created + 80 * 3600) }, s.repo).stdout, /^STALE/);
});
