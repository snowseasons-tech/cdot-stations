#!/usr/bin/env bash
# Installs and registers a GitHub Actions self-hosted runner for this repo on THIS machine, as a systemd service.
# Run it as the user that should execute deploys (it must be able to run `docker`):
#   bash scripts/setup-runner.sh
# Needs: gh (logged in with repo admin rights), curl, sudo. Downloads the official runner from github.com/actions/runner
# and verifies its SHA-256 against the value published in the release notes.
set -euo pipefail

REPO=${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}
DIR=${RUNNER_DIR:-$HOME/actions-runner-cdot-stations}
LABELS=cdot-stations

docker info >/dev/null 2>&1 || { echo "This user can't run docker. Fix first: sudo usermod -aG docker $USER, then log out and back in." >&2; exit 1; }
[ ! -e "$DIR/.runner" ] || { echo "A runner is already configured in $DIR" >&2; exit 1; }

release=$(gh api repos/actions/runner/releases/latest)
version=$(jq -r .tag_name <<< "$release" | sed 's/^v//')
file="actions-runner-linux-x64-$version.tar.gz"
expected=$(jq -r .body <<< "$release" | grep -o "<!-- BEGIN SHA linux-x64 -->[0-9a-f]*<!-- END SHA linux-x64 -->" | sed 's/<[^>]*>//g')
[ -n "$expected" ] || { echo "Couldn't find the published checksum for $file" >&2; exit 1; }

echo "Downloading $file from github.com/actions/runner into $DIR"
mkdir -p "$DIR" && cd "$DIR"
curl -fsSL -o "$file" "https://github.com/actions/runner/releases/download/v$version/$file"
echo "$expected  $file" | sha256sum -c -
tar xzf "$file" && rm "$file"

token=$(gh api -X POST "repos/$REPO/actions/runners/registration-token" -q .token)
./config.sh --unattended --url "https://github.com/$REPO" --token "$token" --name "$(hostname)-cdot-stations" --labels "$LABELS" --replace
sudo ./svc.sh install "$USER"
sudo ./svc.sh start
echo "Runner is up. Enable deploys with: gh variable set DEPLOY_ENABLED --body true"
