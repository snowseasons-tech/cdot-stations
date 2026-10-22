#!/usr/bin/env bash
# Backs up the app's status data (current statuses + history) from the running container:
#   1. a timestamped copy in $BACKUP_DIR (skipped if identical to the newest), pruned by age
#   2. a commit in a private GitHub repo, so the data also survives losing this machine; every successful run also
#      updates heartbeat.txt there, which the repo's scheduled check uses to notice runs that stopped happening
# status.json is written atomically by the app (temp file + rename), so reading it is always consistent.
# Config via env: CONTAINER, BACKUP_BASE, BACKUP_DIR, REPO_DIR, BACKUP_REMOTE ("" disables off-site), KEEP_DAYS, KEEP_MIN
set -euo pipefail

CONTAINER=${CONTAINER:-cdot-stations}
BASE=${BACKUP_BASE:-$HOME/cdot-stations}
BACKUP_DIR=${BACKUP_DIR:-$BASE/backups}
REPO_DIR=${REPO_DIR:-$BASE/backup-repo}
REMOTE=${BACKUP_REMOTE-https://github.com/snowseasons-tech/cdot-stations-backup.git}
KEEP_DAYS=${KEEP_DAYS:-30}
KEEP_MIN=${KEEP_MIN:-7}
STATUS_PATH=/var/lib/cdot/status.json

# Pushes the heartbeat (always) and the status file (if given) to the backup repo.
offsite() {
  local status_file=$1
  [ -n "$REMOTE" ] || { echo "$(date -u +%FT%TZ) off-site: disabled"; return 0; }
  [ -d "$REPO_DIR/.git" ] || git clone -q "$REMOTE" "$REPO_DIR"
  (
    cd "$REPO_DIR"
    git pull -q --ff-only
    [ -z "$status_file" ] || cp "$status_file" status.json
    date -u +%FT%TZ > heartbeat.txt
    git add -A
    if git diff --cached --quiet; then
      echo "$(date -u +%FT%TZ) off-site: unchanged"
      return 0
    fi
    local msg="Heartbeat"
    git diff --cached --quiet -- status.json || msg="Status backup"
    git -c user.name="cdot-stations backup" -c user.email="backup@localhost" commit -q -m "$msg $(date -u +%FT%TZ)"
    git push -q origin HEAD
    echo "$(date -u +%FT%TZ) off-site: pushed $(git rev-parse --short HEAD) ($msg)"
  )
}

mkdir -p "$BACKUP_DIR"
tmp=$(mktemp "$BACKUP_DIR/.incoming.XXXXXX")
trap 'rm -f "$tmp"' EXIT

# A missing status file is normal (nothing saved yet); docker being unreachable or the container being down is not,
# and must fail loudly rather than look like "nothing to back up".
if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != true ]; then
  echo "$(date -u +%FT%TZ) cannot reach a running container named $CONTAINER (is docker accessible to this user?)" >&2
  exit 1
fi
if ! docker exec "$CONTAINER" test -f "$STATUS_PATH"; then
  echo "$(date -u +%FT%TZ) no status file yet; nothing to back up"
  offsite ""
  exit 0
fi
docker exec "$CONTAINER" cat "$STATUS_PATH" > "$tmp"
if ! jq -e '(.current | type == "object") and (.history | type == "array")' "$tmp" >/dev/null 2>&1; then
  echo "$(date -u +%FT%TZ) status file is not valid JSON in the expected shape; NOT backing it up" >&2
  exit 1
fi

# 1. local copy
newest=$(find "$BACKUP_DIR" -maxdepth 1 -name 'status-*.json' | sort | tail -n 1)
if [ -n "$newest" ] && cmp -s "$tmp" "$newest"; then
  echo "$(date -u +%FT%TZ) local: unchanged since $(basename "$newest")"
else
  dest="$BACKUP_DIR/status-$(date -u +%Y%m%dT%H%M%SZ).json"
  cp "$tmp" "$dest"
  echo "$(date -u +%FT%TZ) local: wrote $(basename "$dest")"
fi

# prune: delete copies older than KEEP_DAYS, but always keep the newest KEEP_MIN
find "$BACKUP_DIR" -maxdepth 1 -name 'status-*.json' | sort -r | tail -n +"$((KEEP_MIN + 1))" | while read -r f; do
  [ -n "$(find "$f" -mtime +"$KEEP_DAYS")" ] && rm -f "$f" && echo "$(date -u +%FT%TZ) local: pruned $(basename "$f")"
done

# 2. off-site copy
offsite "$tmp"
