#!/usr/bin/env bash
# Probe the local CDOT Stations API and alert through a GitHub issue.
# A single "site-down" issue stays open until the API recovers.
# Config: APP_URL (default http://127.0.0.1:8080), ALERT_REPO (default backup repo).
set -uo pipefail

cd "$(dirname "$0")/.."
APP_URL=${APP_URL:-http://127.0.0.1:8080}
ALERT_REPO=${ALERT_REPO-snowseasons-tech/cdot-stations-backup}
LABEL=site-down
HEALTH_URL="${APP_URL%/}/api/stations"

# Avoid overlapping cron runs if a network or GitHub request takes longer than expected.
if command -v flock >/dev/null 2>&1; then
  exec 9>"${TMPDIR:-/tmp}/cdot-stations-site-health.lock"
  flock -n 9 || exit 0
fi

output=$(curl --fail --silent --show-error --connect-timeout 3 --max-time 10 "$HEALTH_URL" 2>&1)
health_code=$?
if [ "$health_code" -eq 0 ] && ! printf '%s' "$output" | jq -e 'type == "object" and (.stations | type == "array")' >/dev/null 2>&1; then
  health_code=1
  output="Health endpoint returned an invalid response (expected an object with a stations array)."
fi

now=$(date -u +%FT%TZ)
host=$(hostname)
if [ "$health_code" -ne 0 ]; then
  printf '%s site health: FAIL (%s)\n' "$now" "$HEALTH_URL"
  [ -z "$output" ] || printf '%s\n' "$output" | tail -n 10
else
  printf '%s site health: OK (%s)\n' "$now" "$HEALTH_URL"
fi

[ -n "$ALERT_REPO" ] || exit "$health_code"

open_issues() {
  gh issue list -R "$ALERT_REPO" -l "$LABEL" -s open --json number --jq '.[].number' 2>/dev/null
}

issues=$(open_issues)
lookup_code=$?
if [ "$lookup_code" -ne 0 ]; then
  echo "alert: could not query open site-health issues in $ALERT_REPO" >&2
  exit "$health_code"
fi

if [ "$health_code" -ne 0 ]; then
  body=$(printf 'The CDOT Stations API at `%s` on `%s` failed its health check at %s.\n\nLast output:\n```\n%s\n```\n\nThe check runs every five minutes. This issue closes when the API responds with the expected JSON again.' \
    "$HEALTH_URL" "$host" "$now" "$(printf '%s\n' "$output" | tail -n 10)")
  number=$(printf '%s\n' "$issues" | sed -n '1p')
  if [ -n "$number" ]; then
    gh issue comment "$number" -R "$ALERT_REPO" -b "$body" >/dev/null 2>&1 || echo "alert: could not comment on site-down issue #$number" >&2
  else
    gh label create "$LABEL" -R "$ALERT_REPO" --color B60205 --description "Automated: CDOT Stations API unreachable" --force >/dev/null 2>&1 || true
    gh issue create -R "$ALERT_REPO" -l "$LABEL" -t "CDOT Stations API down on $host" -b "$body" >/dev/null 2>&1 || echo "alert: could not open a site-down issue in $ALERT_REPO" >&2
  fi
else
  while IFS= read -r number; do
    [ -n "$number" ] || continue
    gh issue comment "$number" -R "$ALERT_REPO" -b "Recovered: the CDOT Stations API responded successfully at $now." >/dev/null 2>&1
    gh issue close "$number" -R "$ALERT_REPO" >/dev/null 2>&1 || echo "alert: could not close site-down issue #$number" >&2
  done <<< "$issues"
fi

exit "$health_code"
