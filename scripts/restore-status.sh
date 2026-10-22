#!/usr/bin/env bash
# Restores status data from a backup file into the running container and restarts it (the app reads
# status.json only at startup). The current file is saved first as pre-restore-<time>.json in $BACKUP_DIR.
#   bash scripts/restore-status.sh <backup-file> [--yes]
# Get a backup from ~/cdot-stations/backups/ or from the backup repo (status.json, any commit: git show <sha>:status.json > file).
set -euo pipefail

FILE=${1:?usage: restore-status.sh <backup-file> [--yes]}
CONTAINER=${CONTAINER:-cdot-stations}
BACKUP_DIR=${BACKUP_DIR:-${BACKUP_BASE:-$HOME/cdot-stations}/backups}
STATUS_PATH=/var/lib/cdot/status.json

jq -e '(.current | type == "object") and (.history | type == "array")' "$FILE" >/dev/null \
  || { echo "$FILE is not a valid status backup" >&2; exit 1; }

echo "Restoring $FILE: $(jq '.current | length' "$FILE") stations with status, $(jq '.history | length' "$FILE") history entries."
if [ "${2:-}" != "--yes" ]; then
  read -r -p "This replaces the current status data and restarts $CONTAINER. Continue? [y/N] " ok
  [ "$ok" = y ] || [ "$ok" = Y ] || { echo "Aborted."; exit 1; }
fi

mkdir -p "$BACKUP_DIR"
if docker exec "$CONTAINER" test -f "$STATUS_PATH"; then
  saved="$BACKUP_DIR/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).json"
  docker exec "$CONTAINER" cat "$STATUS_PATH" > "$saved"
  echo "Saved the current data as $saved"
fi

docker cp "$FILE" "$CONTAINER:$STATUS_PATH"
docker restart "$CONTAINER" >/dev/null
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER")" = healthy ] && { echo "Restored; $CONTAINER is healthy."; exit 0; }
  sleep 2
done
echo "$CONTAINER did not become healthy after the restore; check: docker logs $CONTAINER" >&2
exit 1
