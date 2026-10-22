#!/usr/bin/env bash
# Restores saved data from a backup file into the running container and restarts it (the app reads its data files
# only at startup). Works for both kinds of backup, detected from the file: status data (status-*.json) and push
# followers (subscriptions-*.json). The current file is saved first as pre-restore-<kind>-<time>.json in $BACKUP_DIR.
#   bash scripts/restore-status.sh <backup-file> [--yes]
# Get a backup from ~/cdot-stations/backups/ or from the backup repo (status.json, any commit: git show <sha>:status.json > file).
set -euo pipefail

FILE=${1:?usage: restore-status.sh <backup-file> [--yes]}
CONTAINER=${CONTAINER:-cdot-stations}
BACKUP_DIR=${BACKUP_DIR:-${BACKUP_BASE:-$HOME/cdot-stations}/backups}
# Which kind of backup is this? Status data and the push followers list are different shapes.
if jq -e '(.current | type == "object") and (.history | type == "array")' "$FILE" >/dev/null 2>&1; then
  KIND=status
  TARGET=/var/lib/cdot/status.json
  DESC="$(jq '.current | length' "$FILE") stations with status, $(jq '.history | length' "$FILE") history entries"
elif jq -e '.subscriptions | type == "object"' "$FILE" >/dev/null 2>&1; then
  KIND=subscriptions
  TARGET=/var/lib/cdot/subscriptions.json
  DESC="$(jq '.subscriptions | length' "$FILE") push subscriptions"
else
  echo "$FILE is not a valid status or subscriptions backup" >&2
  exit 1
fi

echo "Restoring $KIND from $FILE: $DESC."
if [ "${2:-}" != "--yes" ]; then
  read -r -p "This replaces the current $KIND data and restarts $CONTAINER. Continue? [y/N] " ok
  [ "$ok" = y ] || [ "$ok" = Y ] || { echo "Aborted."; exit 1; }
fi

mkdir -p "$BACKUP_DIR"
if docker exec "$CONTAINER" test -f "$TARGET"; then
  saved="$BACKUP_DIR/pre-restore-$KIND-$(date -u +%Y%m%dT%H%M%SZ).json"
  docker exec "$CONTAINER" cat "$TARGET" > "$saved"
  echo "Saved the current data as $saved"
fi

docker cp "$FILE" "$CONTAINER:$TARGET"
docker restart "$CONTAINER" >/dev/null
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER")" = healthy ] && { echo "Restored; $CONTAINER is healthy."; exit 0; }
  sleep 2
done
echo "$CONTAINER did not become healthy after the restore; check: docker logs $CONTAINER" >&2
exit 1
