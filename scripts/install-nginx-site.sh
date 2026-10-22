#!/usr/bin/env bash
# Installs deploy/nginx-cdot-stations.conf as an nginx site and reloads nginx (needs sudo).
# If the new config fails `nginx -t`, the site is removed again and nginx is left untouched.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)/deploy/nginx-cdot-stations.conf"
AVAILABLE=/etc/nginx/sites-available/cdot-stations
ENABLED=/etc/nginx/sites-enabled/cdot-stations

sudo install -m 644 "$SRC" "$AVAILABLE"
sudo ln -sfn "$AVAILABLE" "$ENABLED"
if sudo nginx -t; then
  sudo systemctl reload nginx
  echo "nginx now forwards port 8080 to the app."
else
  sudo rm -f "$ENABLED"
  echo "nginx rejected the config; the site was not enabled." >&2
  exit 1
fi
