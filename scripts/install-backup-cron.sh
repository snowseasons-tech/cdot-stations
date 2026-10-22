#!/usr/bin/env bash
# Adds (or updates) a daily cron job for this user that runs scripts/backup-run.sh from this checkout.
#   bash scripts/install-backup-cron.sh [schedule]     default schedule: "30 3 * * *" (03:30 daily, server local time)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHEDULE=${1:-"30 3 * * *"}
LOG='$HOME/cdot-stations/backup.log'
MARK="# cdot-stations status backup"

mkdir -p "$HOME/cdot-stations"
line="$SCHEDULE cd '$ROOT' && bash scripts/backup-run.sh >> $LOG 2>&1 $MARK"
{ crontab -l 2>/dev/null | grep -vF "$MARK" || true; echo "$line"; } | crontab -
echo "Installed: $line"
