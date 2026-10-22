#!/usr/bin/env bash
# Backs up the app's saved data from the running container: status.json (current statuses + history), and when they
# exist, subscriptions.json (who follows which station) and positions.json (pins the team has moved). For each:
#   1. a timestamped copy in $BACKUP_DIR (skipped if identical to the newest), pruned by age
#   2. a commit in a private GitHub repo, so the data also survives losing this machine; every successful run also
#      updates heartbeat.txt there, which the repo's scheduled check uses to notice runs that stopped happening
# Both files are written atomically by the app (temp file + rename), so reading them is always consistent.
# subscriptions.json holds each phone's push address and keys: it is only as private as the backup repo, so keep that private.
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
SUBS_PATH=/var/lib/cdot/subscriptions.json
POSITIONS_PATH=/var/lib/cdot/positions.json

# Pushes the heartbeat (always) and whichever data files are given (status, subscriptions, positions) to the backup repo.
offsite() {
  local status_file=$1 subs_file=$2 positions_file=$3
  [ -n "$REMOTE" ] || { echo "$(date -u +%FT%TZ) off-site: disabled"; return 0; }
  [ -d "$REPO_DIR/.git" ] || git clone -q "$REMOTE" "$REPO_DIR"
  (
    cd "$REPO_DIR"
    git pull -q --ff-only
    [ -z "$status_file" ] || cp "$status_file" status.json
    [ -z "$subs_file" ] || cp "$subs_file" subscriptions.json
    [ -z "$positions_file" ] || cp "$positions_file" positions.json
    date -u +%FT%TZ > heartbeat.txt
    git add -A
    if git diff --cached --quiet; then
      echo "$(date -u +%FT%TZ) off-site: unchanged"
      return 0
    fi
    local msg="Heartbeat"
    git diff --cached --quiet -- subscriptions.json || msg="Subscriptions backup"
    git diff --cached --quiet -- positions.json || msg="Positions backup"
    git diff --cached --quiet -- status.json || msg="Status backup"
    git -c user.name="cdot-stations backup" -c user.email="backup@localhost" commit -q -m "$msg $(date -u +%FT%TZ)"
    git push -q origin HEAD
    echo "$(date -u +%FT%TZ) off-site: pushed $(git rev-parse --short HEAD) ($msg)"
  )
}

mkdir -p "$BACKUP_DIR"
tmp_status=$(mktemp "$BACKUP_DIR/.incoming.XXXXXX")
tmp_subs=$(mktemp "$BACKUP_DIR/.incoming.XXXXXX")
tmp_positions=$(mktemp "$BACKUP_DIR/.incoming.XXXXXX")
trap 'rm -f "$tmp_status" "$tmp_subs" "$tmp_positions"' EXIT

# A missing data file is normal (nothing saved yet); docker being unreachable or the container being down is not,
# and must fail loudly rather than look like "nothing to back up".
if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != true ]; then
  echo "$(date -u +%FT%TZ) cannot reach a running container named $CONTAINER (is docker accessible to this user?)" >&2
  exit 1
fi

# fetch <path in container> <temp file> <jq check> <label>: returns 1 if the file doesn't exist yet; exits if it is invalid.
fetch() {
  docker exec "$CONTAINER" test -f "$1" || return 1
  docker exec "$CONTAINER" cat "$1" > "$2"
  if ! jq -e "$3" "$2" >/dev/null 2>&1; then
    echo "$(date -u +%FT%TZ) $4 file is not valid JSON in the expected shape; NOT backing it up" >&2
    exit 1
  fi
}

# local_copy <prefix> <temp file>: timestamped copy unless identical to the newest, then prune.
local_copy() {
  local prefix=$1 file=$2 newest dest
  newest=$(find "$BACKUP_DIR" -maxdepth 1 -name "$prefix-*.json" | sort | tail -n 1)
  if [ -n "$newest" ] && cmp -s "$file" "$newest"; then
    echo "$(date -u +%FT%TZ) local: $prefix unchanged since $(basename "$newest")"
  else
    dest="$BACKUP_DIR/$prefix-$(date -u +%Y%m%dT%H%M%SZ).json"
    cp "$file" "$dest"
    echo "$(date -u +%FT%TZ) local: wrote $(basename "$dest")"
  fi
  # prune: delete copies older than KEEP_DAYS, but always keep the newest KEEP_MIN
  find "$BACKUP_DIR" -maxdepth 1 -name "$prefix-*.json" | sort -r | tail -n +"$((KEEP_MIN + 1))" | while read -r f; do
    [ -n "$(find "$f" -mtime +"$KEEP_DAYS")" ] && rm -f "$f" && echo "$(date -u +%FT%TZ) local: pruned $(basename "$f")"
  done
  return 0 # the loop's own status is "nothing left to prune", which must not look like a failure under set -e
}

status_file=""; subs_file=""; positions_file=""
if fetch "$STATUS_PATH" "$tmp_status" '(.current | type == "object") and (.history | type == "array")' status; then
  status_file=$tmp_status
  local_copy status "$tmp_status"
else
  echo "$(date -u +%FT%TZ) no status file yet; nothing to back up"
fi
if fetch "$SUBS_PATH" "$tmp_subs" '.subscriptions | type == "object"' subscriptions; then
  subs_file=$tmp_subs
  local_copy subscriptions "$tmp_subs"
fi

if fetch "$POSITIONS_PATH" "$tmp_positions" '(.positions | type == "object") and (.history | type == "array")' positions; then
  positions_file=$tmp_positions
  local_copy positions "$tmp_positions"
fi

offsite "$status_file" "$subs_file" "$positions_file"
