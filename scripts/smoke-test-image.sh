#!/usr/bin/env bash
# Starts the given image and checks it boots, serves the app, and enforces the write token.
#   bash scripts/smoke-test-image.sh <image>
set -euo pipefail
IMAGE=${1:?image required}
NAME=cdot-smoke-$$
PORT=${SMOKE_PORT:-3999}

cleanup() { docker rm -fv "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Push needs VAPID keys; make a throwaway pair with the image's own script (this also proves web-push is installed).
keys=$(docker run --rm "$IMAGE" node scripts/generate-vapid-keys.js)
VAPID_PUBLIC_KEY=$(sed -n 's/^VAPID_PUBLIC_KEY=//p' <<<"$keys")
VAPID_PRIVATE_KEY=$(sed -n 's/^VAPID_PRIVATE_KEY=//p' <<<"$keys")

docker run -d --name "$NAME" -p "127.0.0.1:$PORT:3000" -e STATUS_TOKEN=smoke-test-token \
  -e VAPID_PUBLIC_KEY="$VAPID_PUBLIC_KEY" -e VAPID_PRIVATE_KEY="$VAPID_PRIVATE_KEY" -e VAPID_SUBJECT=mailto:smoke@example.com "$IMAGE" >/dev/null

for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] || { echo "Container exited:" >&2; docker logs "$NAME" >&2; exit 1; }
  sleep 1
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] || { echo "Container never became healthy:" >&2; docker logs "$NAME" >&2; exit 1; }

check() { # description expected-status curl-args...
  local desc=$1 want=$2; shift 2
  local got; got=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  [ "$got" = "$want" ] || { echo "FAIL $desc: expected $want, got $got" >&2; docker logs "$NAME" >&2; exit 1; }
  echo "ok   $desc"
}
B=http://127.0.0.1:$PORT
check "home page" 200 "$B/"
check "web app manifest" 200 "$B/manifest.webmanifest"
check "service worker" 200 "$B/sw.js"
check "app icon" 200 "$B/icons/icon-192.png"
check "station list" 200 "$B/api/stations"
check "inspection data is baked in" 200 "$B/api/stations/limon/inspections"
check "inspection locations are baked in" 200 "$B/api/inspection-locations?levels=1,2"
body=$(curl -s "$B/api/inspection-locations?levels=1,2")
[ "$(printf '%s' "$body" | jq '.locations | length')" -gt 100 ] || { echo "FAIL: too few inspection locations in the image" >&2; exit 1; }
echo "ok   inspection locations are non-empty"
check "bad level is rejected" 400 "$B/api/inspection-locations?levels=9"
check "write without token is rejected" 401 -X PUT -H 'content-type: application/json' -d '{"status":"open"}' "$B/api/stations/limon/status"
check "write with token works" 200 -X PUT -H 'content-type: application/json' -H 'authorization: Bearer smoke-test-token' -d '{"status":"open"}' "$B/api/stations/limon/status"
check "push key is served" 200 "$B/api/push/key"
P256=$(printf 'B%.0s' $(seq 1 87)); AUTH=$(printf 'a%.0s' $(seq 1 22))
follow() { printf '{"subscription":{"endpoint":"%s","keys":{"p256dh":"%s","auth":"%s"}},"stations":["limon"]}' "$1" "$P256" "$AUTH"; }
check "following a station works" 200 -X POST -H 'content-type: application/json' -d "$(follow https://fcm.googleapis.com/fcm/send/smoke)" "$B/api/push/subscribe"
check "a non-push address is rejected" 400 -X POST -H 'content-type: application/json' -d "$(follow http://169.254.169.254/x)" "$B/api/push/subscribe"
check "a forged (non-JSON) follow is rejected" 415 -X POST -H 'content-type: text/plain' -d "$(follow https://fcm.googleapis.com/fcm/send/smoke)" "$B/api/push/subscribe"
check "position history is readable" 200 "$B/api/stations/limon/positions"
check "moving a pin needs the token" 401 -X PUT -H 'content-type: application/json' -d '{"lat":39.27,"lng":-103.68}' "$B/api/stations/limon/locations/WB/position"
check "a position outside Colorado is rejected" 400 -X PUT -H 'content-type: application/json' -H 'authorization: Bearer smoke-test-token' -d '{"lat":39.27,"lng":103.68}' "$B/api/stations/limon/locations/WB/position"
check "a pin can be moved and put back" 200 -X PUT -H 'content-type: application/json' -H 'authorization: Bearer smoke-test-token' -d '{"lat":39.274,"lng":-103.686,"note":"smoke test"}' "$B/api/stations/limon/locations/WB/position"
check "...and reverted" 200 -X DELETE -H 'authorization: Bearer smoke-test-token' "$B/api/stations/limon/locations/WB/position"
