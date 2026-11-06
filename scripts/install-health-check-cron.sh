#!/usr/bin/env bash
# Installs or updates the five-minute CDOT Stations API health check.
#   bash scripts/install-health-check-cron.sh [schedule] [app-url]
# Defaults: every 5 minutes; http://127.0.0.1:8080
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHEDULE=${1:-"*/5 * * * *"}
APP_URL=${2:-"http://127.0.0.1:8080"}
LOG='$HOME/cdot-stations/site-health.log'
MARK="# cdot-stations site health"
mkdir -p "$HOME/cdot-stations"
quoted_url=$(printf '%q' "$APP_URL")
line="$SCHEDULE cd '$ROOT' && APP_URL=$quoted_url bash scripts/site-health-check.sh >> $LOG 2>&1 $MARK"
{ crontab -l 2>/dev/null | grep -vF "$MARK" || true; echo "$line"; } | crontab -
echo "Installed: $line"
