# End-to-end test of scripts/backup-status.sh and restore-status.sh against a throwaway container and a local
# bare git repo standing in for GitHub. Needs docker, jq and git; leaves the real deployment untouched.
#   bash test/e2e/backup.sh [image]     (default image: the one the running cdot-stations container uses)
set -euo pipefail
cd "$(dirname "$0")/../.."
T=$(mktemp -d)
IMAGE=${1:-$(docker inspect -f '{{.Config.Image}}' cdot-stations)}
export CONTAINER=cdot-backup-test BACKUP_BASE=$T/base BACKUP_REMOTE=$T/remote.git
cleanup() { docker rm -f cdot-backup-test >/dev/null 2>&1 || true; docker volume rm -f cdot-backup-test-vol >/dev/null 2>&1 || true; }
trap 'cleanup; rm -rf "$T"' EXIT; cleanup
git init -q --bare -b main $T/remote.git; git clone -q $T/remote.git $T/seed 2>/dev/null; (cd $T/seed && git checkout -q -b main && echo seed > README && git add . && git -c user.name=t -c user.email=t@t commit -qm init && git push -q origin main)
docker run -d --name cdot-backup-test -p 127.0.0.1:3998:3000 -e STATUS_TOKEN=t -v cdot-backup-test-vol:/var/lib/cdot "$IMAGE" >/dev/null
for _ in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' cdot-backup-test)" = healthy ] && break; sleep 1; done
put() { curl -s -o /dev/null -X PUT -H 'content-type: application/json' -H 'authorization: Bearer t' -d "{\"status\":\"$2\",\"note\":\"$3\"}" http://127.0.0.1:3998/api/stations/$1/status; }
expect() { [ "$1" = "$2" ] && echo "   ok: $2" || { echo "   FAIL: expected '$1', got '$2'" >&2; exit 1; }; }
nfiles() { find $T/base/backups -name 'status-*.json' | wc -l; }
remote_commits() { git -C $T/remote.git rev-list --count main; }

echo "0) container missing or docker unreachable must fail, not pass as 'nothing to back up'"
if CONTAINER=cdot-no-such-container bash scripts/backup-status.sh 2>/dev/null; then echo "FAIL: missing container reported success"; exit 1; fi; echo "   ok: failed as expected"
echo "1) no status file yet";            bash scripts/backup-status.sh
echo "2) first status -> backup";        put limon open "no wait"; bash scripts/backup-status.sh; expect "1 2" "$(nfiles) $(remote_commits)"
echo "3) nothing changed";               bash scripts/backup-status.sh; expect "1 2" "$(nfiles) $(remote_commits)"
echo "4) second status -> new backup";   sleep 1; put cortez closed "scale down"; bash scripts/backup-status.sh; expect "2 3" "$(nfiles) $(remote_commits)"
echo "5) prune old copies (KEEP_MIN=2 KEEP_DAYS=30)"
touch -d '60 days ago' $T/base/backups/status-20200101T000000Z.json; cp $T/base/backups/status-20200101T000000Z.json $T/base/backups/status-20200102T000000Z.json; touch -d '59 days ago' $T/base/backups/status-20200102T000000Z.json
KEEP_MIN=2 bash scripts/backup-status.sh | grep -E "pruned|unchanged" ; expect 2 "$(nfiles)"
echo "6) corrupted status file is refused"
docker exec cdot-backup-test sh -c 'echo "{broken" > /var/lib/cdot/status.json'
before=$(nfiles); if bash scripts/backup-status.sh 2>&1; then echo "FAIL: corrupted file was backed up"; exit 1; fi; expect "$before 3" "$(nfiles) $(remote_commits)"
echo "7) restore from the oldest real backup"
oldest=$(find $T/base/backups -name 'status-2026*.json' | sort | head -1)
bash scripts/restore-status.sh "$oldest" --yes
expect "open unknown" "$(curl -s localhost:3998/api/stations/limon | jq -r .status) $(curl -s localhost:3998/api/stations/cortez | jq -r .status)"
expect 1 "$(ls $T/base/backups | grep -c pre-restore)"
echo "8) app can still write after a restore"; put cortez closed again; expect closed "$(curl -s localhost:3998/api/stations/cortez | jq -r .status)"
expect '["cortez","limon"]' "$(git -C $T/remote.git show main:status.json | jq -c '[.current|keys[]]')"
echo "backup e2e: all checks passed"
