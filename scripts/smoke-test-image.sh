#!/usr/bin/env bash
# Starts the given image and checks it boots, serves the app, and enforces the write token.
#   bash scripts/smoke-test-image.sh <image>
set -euo pipefail
IMAGE=${1:?image required}
NAME=cdot-smoke-$$
PORT=${SMOKE_PORT:-3999}

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$NAME" -p "127.0.0.1:$PORT:3000" -e STATUS_TOKEN=smoke-test-token "$IMAGE" >/dev/null

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
check "station list" 200 "$B/api/stations"
check "inspection data is baked in" 200 "$B/api/stations/limon/inspections"
check "inspection locations are baked in" 200 "$B/api/inspection-locations?levels=1,2"
body=$(curl -s "$B/api/inspection-locations?levels=1,2")
[ "$(printf '%s' "$body" | jq '.locations | length')" -gt 100 ] || { echo "FAIL: too few inspection locations in the image" >&2; exit 1; }
echo "ok   inspection locations are non-empty"
check "bad level is rejected" 400 "$B/api/inspection-locations?levels=9"
check "write without token is rejected" 401 -X PUT -H 'content-type: application/json' -d '{"status":"open"}' "$B/api/stations/limon/status"
check "write with token works" 200 -X PUT -H 'content-type: application/json' -H 'authorization: Bearer smoke-test-token' -d '{"status":"open"}' "$B/api/stations/limon/status"
