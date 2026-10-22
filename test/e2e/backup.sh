# End-to-end test of scripts/backup-status.sh and restore-status.sh against a throwaway container and a local
# bare git repo standing in for GitHub. Needs docker, jq and git; leaves the real deployment untouched.
#   bash test/e2e/backup.sh [image]     (default: builds an image from this checkout, so what is tested is what you have)
set -euo pipefail
cd "$(dirname "$0")/../.."
T=$(mktemp -d)
if [ -n "${1:-}" ]; then IMAGE=$1; else IMAGE=cdot-e2e-test; docker build -q -t $IMAGE . >/dev/null; BUILT=1; fi
export CONTAINER=cdot-backup-test BACKUP_BASE=$T/base BACKUP_REMOTE=$T/remote.git
cleanup() { docker rm -f cdot-backup-test >/dev/null 2>&1 || true; docker volume rm -f cdot-backup-test-vol >/dev/null 2>&1 || true; }
trap 'cleanup; [ -z "${BUILT:-}" ] || docker rmi cdot-e2e-test >/dev/null 2>&1 || true; rm -rf "$T"' EXIT; cleanup
git init -q --bare -b main $T/remote.git; git clone -q $T/remote.git $T/seed 2>/dev/null; (cd $T/seed && git checkout -q -b main && echo seed > README && git add . && git -c user.name=t -c user.email=t@t commit -qm init && git push -q origin main)
keys=$(docker run --rm "$IMAGE" node scripts/generate-vapid-keys.js)  # push on, so followers can be created through the real API
docker run -d --name cdot-backup-test -p 127.0.0.1:3998:3000 -e STATUS_TOKEN=t -v cdot-backup-test-vol:/var/lib/cdot \
  -e VAPID_PUBLIC_KEY="$(sed -n 's/^VAPID_PUBLIC_KEY=//p' <<<"$keys")" -e VAPID_PRIVATE_KEY="$(sed -n 's/^VAPID_PRIVATE_KEY=//p' <<<"$keys")" -e VAPID_SUBJECT=mailto:test@example.com "$IMAGE" >/dev/null
for _ in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' cdot-backup-test)" = healthy ] && break; sleep 1; done
put() { curl -s -o /dev/null -X PUT -H 'content-type: application/json' -H 'authorization: Bearer t' -d "{\"status\":\"$2\",\"note\":\"$3\"}" http://127.0.0.1:3998/api/stations/$1/status; }
expect() { [ "$1" = "$2" ] && echo "   ok: $2" || { echo "   FAIL: expected '$1', got '$2'" >&2; exit 1; }; }
nfiles() { find $T/base/backups -name 'status-*.json' | wc -l; }
status_commits() { git -C $T/remote.git log --oneline main -- status.json | wc -l | tr -d ' '; }
heartbeat() { git -C $T/remote.git show main:heartbeat.txt 2>/dev/null || true; }

echo "0) container missing or docker unreachable must fail, not pass as 'nothing to back up'"
if CONTAINER=cdot-no-such-container bash scripts/backup-status.sh 2>/dev/null; then echo "FAIL: missing container reported success"; exit 1; fi; echo "   ok: failed as expected"
echo "1) no status file yet: still pushes a heartbeat, but no status.json"; bash scripts/backup-status.sh
[ -n "$(heartbeat)" ] || { echo "FAIL: no heartbeat pushed"; exit 1; }; expect 0 "$(status_commits)"; sleep 1
echo "2) first status -> backup";        put limon open "no wait"; bash scripts/backup-status.sh; expect "1 1" "$(nfiles) $(status_commits)"
echo "3) nothing changed: no new status commit, but a fresh heartbeat"; before_hb=$(heartbeat); sleep 1; bash scripts/backup-status.sh; [ "$(heartbeat)" != "$before_hb" ] || { echo "FAIL: heartbeat did not advance"; exit 1; }; expect "1 1" "$(nfiles) $(status_commits)"
echo "4) second status -> new backup";   sleep 1; put cortez closed "scale down"; bash scripts/backup-status.sh; expect "2 2" "$(nfiles) $(status_commits)"
echo "5) prune old copies (KEEP_MIN=2 KEEP_DAYS=30)"
touch -d '60 days ago' $T/base/backups/status-20200101T000000Z.json; cp $T/base/backups/status-20200101T000000Z.json $T/base/backups/status-20200102T000000Z.json; touch -d '59 days ago' $T/base/backups/status-20200102T000000Z.json
KEEP_MIN=2 bash scripts/backup-status.sh | grep -E "pruned|unchanged" ; expect 2 "$(nfiles)"
echo "6) corrupted status file is refused"
docker exec cdot-backup-test sh -c 'echo "{broken" > /var/lib/cdot/status.json'
before=$(nfiles); if bash scripts/backup-status.sh 2>&1; then echo "FAIL: corrupted file was backed up"; exit 1; fi; expect "$before 2" "$(nfiles) $(status_commits)"
echo "7) restore from the oldest real backup"
oldest=$(find $T/base/backups -name 'status-2026*.json' | sort | head -1)
bash scripts/restore-status.sh "$oldest" --yes
expect "open unknown" "$(curl -s localhost:3998/api/stations/limon | jq -r .status) $(curl -s localhost:3998/api/stations/cortez | jq -r .status)"
expect 1 "$(ls $T/base/backups | grep -c pre-restore)"
echo "8) app can still write after a restore"; put cortez closed again; expect closed "$(curl -s localhost:3998/api/stations/cortez | jq -r .status)"
expect '["cortez","limon"]' "$(git -C $T/remote.git show main:status.json | jq -c '[.current|keys[]]')"

# ---- push followers (subscriptions.json)
P256=$(printf 'B%.0s' $(seq 1 87)); AUTH=$(printf 'a%.0s' $(seq 1 22))
follow() { curl -s -o /dev/null -X POST -H 'content-type: application/json' -d "{\"subscription\":{\"endpoint\":\"https://fcm.googleapis.com/fcm/send/$1\",\"keys\":{\"p256dh\":\"$P256\",\"auth\":\"$AUTH\"}},\"stations\":[\"$2\"]}" http://127.0.0.1:3998/api/push/subscribe; }
following() { curl -s -X POST -H 'content-type: application/json' -d "{\"endpoint\":\"https://fcm.googleapis.com/fcm/send/$1\"}" http://127.0.0.1:3998/api/push/following | jq -c .stations; }
sub_files() { find $T/base/backups -name 'subscriptions-*.json' | wc -l | tr -d ' '; }
remote_subs() { git -C $T/remote.git show main:subscriptions.json 2>/dev/null | jq '.subscriptions | length' || echo 0; }

echo "9) a follower is backed up locally and off-site, status backups are unaffected"
expect 0 "$(sub_files)"
sleep 1; follow phone-a limon; bash scripts/backup-status.sh
expect "1 1" "$(sub_files) $(remote_subs)"
expect 3 "$(status_commits)" # the third status commit is the status change made in step 8; adding a follower adds none

echo "10) nothing changed: no new subscription copy"
sleep 1; bash scripts/backup-status.sh; expect "1 1" "$(sub_files) $(remote_subs)"

echo "11) a second follower makes a new copy and an off-site update"
sleep 1; follow phone-b cortez; bash scripts/backup-status.sh; expect "2 2" "$(sub_files) $(remote_subs)"

echo "12) a corrupted subscriptions file is refused"
docker exec cdot-backup-test sh -c 'echo "{broken" > /var/lib/cdot/subscriptions.json'
if bash scripts/backup-status.sh 2>&1; then echo "FAIL: corrupted subscriptions were backed up"; exit 1; fi; expect "2 2" "$(sub_files) $(remote_subs)"

echo "13) restoring the first subscriptions backup brings back only the first follower (kind detected from the file)"
first=$(find $T/base/backups -name 'subscriptions-*.json' | sort | head -1)
bash scripts/restore-status.sh "$first" --yes | grep -E "Restoring|healthy"
expect "$(printf '["limon"] []')" "$(printf '%s %s' "$(following phone-a)" "$(following phone-b)")"
expect 1 "$(ls $T/base/backups | grep -c 'pre-restore-subscriptions')"
expect closed "$(curl -s localhost:3998/api/stations/cortez | jq -r .status)" # statuses untouched by a subscriptions restore


# ---- moved pins (positions.json)
move() { curl -s -o /dev/null -X PUT -H 'content-type: application/json' -H 'authorization: Bearer t' -d "{\"lat\":$2,\"lng\":$3,\"note\":\"e2e\"}" "http://127.0.0.1:3998/api/stations/limon/locations/$1/position"; }
pos_files() { find $T/base/backups -name 'positions-*.json' | wc -l | tr -d ' '; }
remote_pins() { git -C $T/remote.git show main:positions.json 2>/dev/null | jq '.positions | length' || echo 0; }
limon_wb_lat() { curl -s localhost:3998/api/stations/limon | jq -r '.locations[] | select(.direction=="WB") | .lat'; }

echo "14) a moved pin is backed up locally and off-site"
expect 0 "$(pos_files)"
orig=$(limon_wb_lat); sleep 1; move WB 39.2752 -103.6900; bash scripts/backup-status.sh
expect "1 1" "$(pos_files) $(remote_pins)"
expect 39.2752 "$(limon_wb_lat)"

echo "15) nothing changed: no new positions copy"
sleep 1; bash scripts/backup-status.sh; expect 1 "$(pos_files)"

echo "16) a corrupted positions file is refused"
docker exec cdot-backup-test sh -c 'echo "{broken" > /var/lib/cdot/positions.json'
if bash scripts/backup-status.sh 2>&1; then echo "FAIL: corrupted positions were backed up"; exit 1; fi; expect 1 "$(pos_files)"

echo "17) restoring a positions backup brings the pin back (kind detected from the file)"
bash scripts/restore-status.sh "$(find $T/base/backups -name 'positions-*.json' | sort | head -1)" --yes | grep -E "Restoring|healthy"
expect 39.2752 "$(limon_wb_lat)"
expect 1 "$(ls $T/base/backups | grep -c 'pre-restore-positions')"
expect closed "$(curl -s localhost:3998/api/stations/cortez | jq -r .status)" # statuses untouched

echo "backup e2e: all checks passed"
