#!/usr/bin/env bash
# What cron runs: the status backup, plus alerting through a GitHub issue in the backup repo.
#   - on failure: opens an issue labelled "backup-failed" (or adds a comment if one is already open), so GitHub emails you
#   - on the next success: comments "recovered" and closes it
# The exit status is the backup's, so cron and the log still show the truth. Alerting is best-effort and never changes it.
# Env: ALERT_REPO (default the backup repo; "" disables alerts), BACKUP_CMD (default: bash scripts/backup-status.sh)
set -uo pipefail
cd "$(dirname "$0")/.."

ALERT_REPO=${ALERT_REPO-snowseasons-tech/cdot-stations-backup}
BACKUP_CMD=${BACKUP_CMD:-bash scripts/backup-status.sh}
LABEL=backup-failed

output=$(bash -c "$BACKUP_CMD" 2>&1)
code=$?
[ -z "$output" ] || printf '%s\n' "$output"

[ -n "$ALERT_REPO" ] || exit "$code"

# Numbers of all open failure issues, one per line (GitHub's listing can lag a few seconds behind a new issue).
open_issues() { gh issue list -R "$ALERT_REPO" -l "$LABEL" -s open --json number -q '.[].number' 2>/dev/null; }
now=$(date -u +%FT%TZ)

if [ "$code" -ne 0 ]; then
  body=$(printf 'The status backup on `%s` failed at %s (exit %s).\n\nLast output:\n```\n%s\n```\n\nCheck `~/cdot-stations/backup.log` on the server. This issue closes itself when a backup succeeds again.' \
    "$(hostname)" "$now" "$code" "$(printf '%s\n' "$output" | tail -n 20)")
  number=$(open_issues | head -n 1)
  if [ -n "$number" ]; then
    gh issue comment "$number" -R "$ALERT_REPO" -b "$body" >/dev/null 2>&1 || echo "alert: could not comment on issue #$number" >&2
  else
    gh label create "$LABEL" -R "$ALERT_REPO" --color B60205 --description "Automated: status backup failing" --force >/dev/null 2>&1
    gh issue create -R "$ALERT_REPO" -l "$LABEL" -t "Status backup failed on $(hostname)" -b "$body" >/dev/null 2>&1 || echo "alert: could not open an issue in $ALERT_REPO" >&2
  fi
else
  for number in $(open_issues); do
    gh issue comment "$number" -R "$ALERT_REPO" -b "Recovered: the backup succeeded at $now." >/dev/null 2>&1
    gh issue close "$number" -R "$ALERT_REPO" >/dev/null 2>&1 || echo "alert: could not close issue #$number" >&2
  done
fi
exit "$code"
