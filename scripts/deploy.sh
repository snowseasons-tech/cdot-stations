#!/usr/bin/env bash
# Runs on the server (by the self-hosted runner in the deploy workflow): pulls the image, replaces the
# container, waits for it to report healthy, and restores the previous image if the new one doesn't.
#   bash scripts/deploy.sh <image> <port-mapping>   e.g. ghcr.io/owner/cdot-stations:sha-abc1234 127.0.0.1:3000:3000
# Expects the token env file at ~/cdot-stations/env (written by the workflow).
set -euo pipefail

IMAGE=${1:?image required}
PORTS=${2:-127.0.0.1:3000:3000}
NAME=cdot-stations
ENV_FILE=$HOME/cdot-stations/env

run() {
  docker run -d --name "$NAME" --restart unless-stopped \
    -p "$PORTS" --env-file "$ENV_FILE" -v cdot-data:/var/lib/cdot "$1" >/dev/null
}

healthy() {
  for _ in $(seq 1 30); do
    case "$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo missing)" in
      healthy) return 0 ;;
      unhealthy|missing) return 1 ;;
    esac
    sleep 2
  done
  return 1
}

PREVIOUS=$(docker inspect -f '{{.Config.Image}}' "$NAME" 2>/dev/null || true)

docker pull "$IMAGE"
docker rm -f "$NAME" >/dev/null 2>&1 || true
run "$IMAGE"

if healthy; then
  echo "Deployed $IMAGE"
  docker image prune -f >/dev/null || true
  exit 0
fi

echo "New container did not become healthy; logs:" >&2
docker logs --tail 40 "$NAME" >&2 || true
docker rm -f "$NAME" >/dev/null 2>&1 || true
if [ -n "$PREVIOUS" ]; then
  echo "Rolling back to $PREVIOUS" >&2
  run "$PREVIOUS"
fi
exit 1
