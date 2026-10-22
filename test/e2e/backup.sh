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


# ---- membership purchases (members.json): written by a verified Stripe webhook, so sign one the way Stripe does
SECRET=whsec_e2etest
members_files() { find $T/base/backups -name 'members-*.json' | wc -l | tr -d ' '; }
remote_members() { git -C $T/remote.git show main:members.json 2>/dev/null | jq '.members | length' || echo 0; }
buy() { # session id, email
  local body ts sig
  body=$(printf '{"id":"evt_%s","type":"checkout.session.completed","data":{"object":{"id":"%s","mode":"payment","payment_status":"paid","amount_total":29900,"currency":"usd","created":1700000000,"customer_details":{"email":"%s"},"metadata":{"product":"cdot-founding-member"}}}}' "$1" "$1" "$2")
  ts=$(date +%s); sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
  curl -s -o /dev/null -X POST -H "stripe-signature: t=$ts,v1=$sig" -H 'content-type: application/json' -d "$body" http://127.0.0.1:3998/api/stripe-webhook
}
count_members() { curl -s -H 'authorization: Bearer t' localhost:3998/api/members | jq '.members | length'; }

echo "18) restart with selling on (test settings), record a purchase, and back it up"
docker rm -f cdot-backup-test >/dev/null
docker run -d --name cdot-backup-test -p 127.0.0.1:3998:3000 -e STATUS_TOKEN=t -v cdot-backup-test-vol:/var/lib/cdot \
  -e STRIPE_SECRET_KEY=sk_test_e2e -e STRIPE_WEBHOOK_SECRET=$SECRET -e STRIPE_PRICE_FOUNDING=price_e2e \
  -e JOIN_BASE_URL=https://join.example.com -e JOIN_TERMS_URL=https://example.com/t -e JOIN_REFUND_URL=https://example.com/r -e JOIN_PRIVACY_URL=https://example.com/p "$IMAGE" >/dev/null
for _ in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' cdot-backup-test)" = healthy ] && break; sleep 1; done
expect 0 "$(members_files)"
sleep 1; buy cs_test_e2e_one buyer@example.com
expect 1 "$(count_members)"
bash scripts/backup-status.sh
expect "1 1" "$(members_files) $(remote_members)"

echo "19) nothing changed: no new members copy; a second purchase makes one"
sleep 1; bash scripts/backup-status.sh; expect 1 "$(members_files)"
sleep 1; buy cs_test_e2e_two two@example.com; bash scripts/backup-status.sh; expect "2 2" "$(members_files) $(remote_members)"

echo "20) a corrupted members file is refused"
docker exec cdot-backup-test sh -c 'echo "{broken" > /var/lib/cdot/members.json'
if bash scripts/backup-status.sh 2>&1; then echo "FAIL: corrupted members were backed up"; exit 1; fi; expect 2 "$(members_files)"

echo "21) restoring the first members backup brings back only the first purchase (kind detected from the file)"
bash scripts/restore-status.sh "$(find $T/base/backups -name 'members-*.json' | sort | head -1)" --yes | grep -E "Restoring|healthy"
expect 1 "$(count_members)"
expect 1 "$(ls $T/base/backups | grep -c 'pre-restore-members')"

echo "backup e2e: all checks passed"
