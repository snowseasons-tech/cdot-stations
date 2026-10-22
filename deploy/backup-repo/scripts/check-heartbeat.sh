#!/usr/bin/env bash
# Run by the scheduled workflow inside the backup repo. The server writes heartbeat.txt (a UTC timestamp) on every
# successful backup; if it is older than MAX_HOURS, open an issue labelled "backup-missing" (or comment on the open one).
# When a fresh heartbeat is back, the issue is commented on and closed.
# Before the first heartbeat exists, the repo's first commit date is used with a longer GRACE_HOURS.
# Needs GH_REPO and GH_TOKEN for gh. Test hooks: NOW_EPOCH.
set -euo pipefail
MAX_HOURS=${MAX_HOURS:-30}
GRACE_HOURS=${GRACE_HOURS:-72}
NOW=${NOW_EPOCH:-$(date +%s)}
LABEL=backup-missing

if [ -s heartbeat.txt ]; then
  last=$(date -u -d "$(cat heartbeat.txt)" +%s)
  limit=$MAX_HOURS
  what="Last heartbeat: $(cat heartbeat.txt)."
else
  last=$(git log --reverse --format=%ct | head -n 1)
  limit=$GRACE_HOURS
  what="No heartbeat has ever been written (repo created $(date -u -d "@$last" +%FT%TZ))."
fi
age=$(( (NOW - last) / 3600 ))
number=$(gh issue list -l "$LABEL" -s open --json number -q '.[0].number // empty')

if [ "$age" -gt "$limit" ]; then
  body="No successful status backup has been recorded for ${age}h (alert threshold: ${limit}h). $what

Likely causes: the server is off or offline, cron stopped, or the backup is failing without being able to report it. On the server check \`~/cdot-stations/backup.log\` and \`crontab -l\`. This issue closes itself when a heartbeat arrives."
  if [ -n "$number" ]; then
    gh issue comment "$number" -b "$body" >/dev/null
  else
    gh label create "$LABEL" --color D93F0B --description "Automated: backups have stopped arriving" --force >/dev/null
    gh issue create -l "$LABEL" -t "No status backup received for ${age}h" -b "$body" >/dev/null
  fi
  echo "STALE: ${age}h old (limit ${limit}h)"
else
  if [ -n "$number" ]; then
    gh issue comment "$number" -b "Recovered: heartbeat is ${age}h old. $what" >/dev/null
    gh issue close "$number" >/dev/null
  fi
  echo "OK: ${age}h old (limit ${limit}h)"
fi
