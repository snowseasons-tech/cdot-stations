# CDOT Inspection Stations

[![Test and publish image](https://github.com/snowseasons-tech/cdot-stations/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/snowseasons-tech/cdot-stations/actions/workflows/deploy.yml)

Map and list of Colorado's commercial vehicle inspection stations (CSP/CDOT ports of entry), with a manually maintained open/closed status, notes, and history.

```bash
npm start            # http://127.0.0.1:3000
npm test
npm run sync         # refresh data/stations.json from CDOT
npm run sync:inspections   # refresh data/inspections.json from FMCSA
```

## How it works

A small Node app (no npm dependencies) serves a one-page map and a JSON API. Station facts come from public sources and are baked into the app; only the open/closed status is written at runtime.

```
 CDOT ports layer ─┐
                   ├─ weekly sync ─► data/*.json ─┐   (baked into the image)
 FMCSA inspections ┘                              ▼
 you / importers ── token ──► PUT, POST ────► server.js ──► JSON API ──► browser
                                                  │                      (map + cards, refreshes every 60 s)
                                                  ▼
                                   status.json (Docker volume) ──► daily backup
```

**Three kinds of data, kept apart**

| Data | Source | Changes | Lives in |
|---|---|---|---|
| Stations (name, highway, mileposts, phone, coordinates) | CDOT's public ports-of-entry layer | rarely | `data/stations.json`, in git and the image |
| Inspections (North American Standard, monthly counts per level and out-of-service totals) | FMCSA's public Vehicle Inspection File | weekly refresh | `data/inspections.json`, in git and the image |
| Status (open / closed / unknown, a note, history) | you, or an importer | whenever you update it | `status.json` on a Docker volume, not in git |

**The server** (`server.js`) loads the two read-only data files into memory at startup and keeps status in a small store (`store.js`). It serves the static page from `public/` and the API below. Reads are public. Writing a status or importing needs the `STATUS_TOKEN` bearer token, and repeated wrong tokens lock a client out for a minute. Status is saved to `status.json` after every change by writing a temp file and renaming it, so a crash can't leave a half-written file; the last 1000 changes are kept as history. The file is read only at startup, which is why a restore restarts the container.

**What a station shows.** `unknown` until someone reports it, then `open` or `closed` with an optional note (up to 280 characters) and the time and source of the update (`manual`, or the name of an import source). Platteville is `planned`: it is a future site, so it can't be given a status, though FMCSA has a few inspections recorded there. Each card also shows the last 12 months of inspections with vehicle and driver out-of-service rates, and the Inspections button opens a breakdown by level and by month. Summaries are computed from `data/inspections.json` when requested.

**Where status comes from.** There is no official open/closed feed from CSP or CDOT, so status arrives two ways:
- by hand, from "Update status" on a card (if the server requires a token, the page asks for it the first time and remembers it in the browser);
- from an importer: `scripts/import-status.js` runs an adapter (a CSV or JSON file, or a JSON URL) and posts the records to `/api/import`, which validates them, skips bad or older records, ignores unchanged ones, and tags the rest with their source. A real CSP or other feed would be one more small adapter.

**The page** (`public/`) is plain HTML, CSS and JavaScript plus Leaflet and OpenStreetMap tiles (pinned with integrity hashes). It fetches `/api/stations` every minute and redraws the cards and map pins; pin colour follows the station's state.

**Keeping it running, all automatic** (details in the sections below)
- *Data refresh:* a weekly workflow re-runs both sync scripts and, only if the data changed, commits it and triggers a deploy.
- *Deploy:* a push to `main` runs the tests, builds the Docker image and boots it as a smoke test, publishes it to GitHub Container Registry, then a runner on the server swaps the container (rolling back if the new one isn't healthy). nginx forwards a LAN port to it.
- *Backup:* a daily cron job copies `status.json` locally and to a private GitHub repo, and opens an issue if a backup fails or stops arriving.

**Code map**

| Path | What it does |
|---|---|
| `server.js`, `store.js`, `auth.js` | HTTP server and routes, status storage, token check and lockout |
| `importer.js`, `adapters/` | Validates and applies imported statuses; sources of records |
| `inspections.js` | Rolls monthly inspection rows up into per-station summaries and OOS rates |
| `public/` | The web page |
| `scripts/sync-*.js` | Fetch and aggregate CDOT and FMCSA data (with guards against bad fetches) |
| `scripts/backup-*.sh`, `restore-status.sh` | Backup, alerting and restore |
| `scripts/deploy.sh`, `setup-runner.sh`, `smoke-test-image.sh`, `install-nginx-site.sh` | Deployment helpers |
| `test/` | Unit and API tests (`npm test`) and a Docker-based backup test (`test/e2e/`) |
| `.github/workflows/` | `deploy.yml` (test, publish, deploy) and `refresh-data.yml` |

## Data

- **Locations** come from CDOT's public [POELocations](https://services.arcgis.com/yzB9WM8W0BO3Ql7d/ArcGIS/rest/services/POELocations/FeatureServer) layer (last published 2019). Platteville is flagged as planned.
- **Status** is *not* live. No official open/closed feed was found, so status is entered by hand or imported (see Importing status) and stored in `data/status.json` (gitignored; `STATUS_FILE` in the container), with the last 1000 changes kept as history.

## Config

| Env var | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Bind address |
| `STATUS_TOKEN` | unset | If set, `PUT /api/stations/:id/status` and `POST /api/import` require `Authorization: Bearer <token>` |
| `STATUS_FILE` | `data/status.json` | Where status and history are stored |
| `TRUST_PROXY` | unset | `1` = take the client address from the proxy's `X-Real-IP` (see Security) |
| `ALLOW_OPEN_WRITES` | unset | `1` = allow listening on a non-local address without `STATUS_TOKEN` |

Set `STATUS_TOKEN` before exposing this beyond localhost; the server refuses to listen on a non-local `HOST` without it.

## Inspections (North American Standard)

`data/inspections.json` holds monthly counts per port and inspection level (I–VII), with vehicle and driver out-of-service (OOS) counts, aggregated from FMCSA's public [Vehicle Inspection File](https://data.transportation.gov/d/fx4q-ay7w) (no API key; FMCSA publishes about three years and updates daily). Run `npm run sync:inspections` to refresh it; a weekly workflow does this automatically (see Data refresh).

- A port's inspections are rows with `insp_facility = 'F'` (fixed facility) whose `location_desc` is the port town (`LIMON CO`). Roadside rows in the same town are patrol stops and are excluded, as are other locations like "DOWNIEVILLE-LAWSON-DUMONT CO".
- Vehicle OOS rate is over vehicle inspections (Levels I, II, V, VI); driver OOS rate over driver inspections (Levels I, II, III, VI), matching how FMCSA reports them.
- Platteville is still a planned site but has sporadic fixed-facility inspections in the data, so it shows them.
- Data is as reported to FMCSA: late uploads mean the latest month is partial.
- API: `GET /api/stations/:id/inspections?months=1-36`; a 12-month summary is also on each station in `GET /api/stations`.

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`: tests first, then it builds the Docker image and publishes it to GitHub Container Registry as `ghcr.io/snowseasons-tech/cdot-stations` (tags `latest` and the commit SHA). Before pushing, the workflow boots the built image and checks it serves the app and enforces the token (`scripts/smoke-test-image.sh`), so a broken image is never published. Pull requests only run the tests. The package is private by default, so the host needs a token with `read:packages` to pull it.

```bash
docker run -d --name cdot-stations --restart unless-stopped -p 3000:3000 \
  -e STATUS_TOKEN=<long random string> \
  -v cdot-data:/var/lib/cdot \
  ghcr.io/snowseasons-tech/cdot-stations:latest
```

- The container binds `0.0.0.0` and **refuses to start without `STATUS_TOKEN`** (override with `ALLOW_OPEN_WRITES=1` only on a private network). Reads are public; writing status or importing requires the token.
- Status and history are stored in `STATUS_FILE` (`/var/lib/cdot/status.json` in the image). Mount a volume there or they are lost when the container is replaced.
- Station and inspection data are baked into the image. To refresh them, run `npm run sync` / `npm run sync:inspections`, commit, and push; the workflow rebuilds the image.
- Put it behind HTTPS (Caddy, nginx or your host's proxy) since the token travels in a header.

### Deploy to your server

On pushes to `main`, once the image is published, the `deploy` job runs **on the server itself** through a self-hosted GitHub Actions runner (a home server isn't reachable from GitHub's hosted runners, and this needs no SSH keys or open ports). It pulls the exact commit's image (`sha-<commit>`), replaces the `cdot-stations` container, and waits for its health check. If the new container isn't healthy it restores the previous image and the job fails. Re-run it from the Actions tab if needed.

One-time setup on the server:

```bash
# 1. The runner's user must be able to run docker (log out and back in afterwards)
sudo usermod -aG docker $USER

# 2. Install and register the runner as a service (downloads GitHub's runner, verifies its checksum, uses sudo)
bash scripts/setup-runner.sh

# 3. Turn deploys on
gh variable set DEPLOY_ENABLED --body true
```

The `STATUS_TOKEN` secret (the write token) is set on the repo; the job writes it to `~/cdot-stations/env` (mode 600) on the server and passes it to the container with `--env-file`. GitHub secrets can't be read back, so keep your own copy.

Optional variable `DEPLOY_PORT_MAPPING` (default `127.0.0.1:3000:3000`, for a reverse proxy on the same machine; use `0.0.0.0:3000:3000` if the proxy is on another host).

Notes: the runner executes this repository's workflow code on the server, so keep the repo private and only let trusted people push to it. Only the `deploy` job uses the runner; tests and the image build stay on GitHub-hosted machines, and pull requests never deploy.

### Reverse proxy (nginx)

The container only listens on `127.0.0.1:3000`. `deploy/nginx-cdot-stations.conf` makes the machine's existing nginx forward LAN port **8080** to it (plain HTTP, for a trusted home network; the write token is visible to anyone sniffing that network). Install it once:

```bash
bash scripts/install-nginx-site.sh   # sudo: copies the site into sites-available, enables it, runs nginx -t, reloads
```

It leaves the existing port-80 default site alone and removes the new site again if `nginx -t` fails. Then open **http://192.168.0.20:8080** (the server's wired address; the Wi-Fi address `192.168.0.91` works too). Both come from DHCP and can change, so a reservation in your router keeps them stable. If another device can't connect, check the firewall (`sudo ufw allow 8080/tcp`).

## Backups

Station status and history live only in the `cdot-data` Docker volume, so they are backed up separately (station and inspection data come from git and are rebuilt with the image).

`scripts/backup-run.sh` (which calls `scripts/backup-status.sh`) runs **daily at 03:30 server time** from cron (installed with `bash scripts/install-backup-cron.sh`; remove it with `crontab -e`). Each run:

1. reads `status.json` from the running container (the app writes it atomically, so the copy is always consistent) and refuses to back up anything that isn't valid status data;
2. saves a timestamped copy in `~/cdot-stations/backups/` unless nothing changed, keeping at least the 7 newest and deleting the rest after 30 days;
3. commits the same file to the private repo [snowseasons-tech/cdot-stations-backup](https://github.com/snowseasons-tech/cdot-stations-backup), so you also survive losing the machine, and git keeps every version. It also updates `heartbeat.txt` there on every successful run (a small commit a day, even when no statuses exist yet); use `git log -- status.json` to see only real data changes.

Output goes to `~/cdot-stations/backup.log`. A failed push leaves the local copy in place and the next run retries. The off-site push uses the stored `gh` login.

### Alerts

Two independent layers, both delivered as GitHub issues in the backup repo (GitHub emails you):

- **Failure** (`backup-failed` issue): if a run fails, `backup-run.sh` opens an issue with the last output, or comments on the one already open. The next successful run comments "Recovered" and closes every open one. This is best-effort: if GitHub or `gh` is the thing that's broken, the alert can't be sent, which is why the second layer exists.
- **Missing** (`backup-missing` issue): a scheduled workflow in the backup repo runs daily at 12:00 UTC and opens an issue if `heartbeat.txt` is more than 30 hours old, i.e. a daily run was missed (server off or offline, cron stopped, or failures that couldn't report themselves). It closes the issue when a heartbeat returns. Before the first heartbeat there is a 72-hour grace period. Its source is in `deploy/backup-repo/` (copied to the backup repo).

Set `ALERT_REPO=""` to switch off failure alerts. Tests: `npm test` covers the alert logic with a fake `gh`; `test/e2e/backup.sh` covers the heartbeat against a real container.

To restore (it saves the current data first as `pre-restore-<time>.json`, replaces `status.json`, and restarts the container, since the app only reads it at startup):

```bash
bash scripts/restore-status.sh ~/cdot-stations/backups/status-<time>.json
# or an older version from the backup repo:
git -C ~/cdot-stations/backup-repo show <commit>:status.json > /tmp/status.json && bash scripts/restore-status.sh /tmp/status.json
```

`bash test/e2e/backup.sh` exercises backup, pruning, refusal of corrupt files and restore against a throwaway container and a local git repo (needs Docker; not part of `npm test`).

## Data refresh

`.github/workflows/refresh-data.yml` runs **every Monday at 06:17 UTC** (and on demand from the Actions tab, or with `gh workflow run refresh-data.yml`). It re-fetches CDOT's port locations and FMCSA's inspection data, runs the tests, and, only if the data actually changed (the fetch timestamp alone doesn't count), commits it to `main` as `github-actions[bot]` and dispatches the normal test → publish → deploy pipeline. A run with no changes ends quietly. Each run's summary shows what changed.

The sync scripts refuse to overwrite the data (the job fails, and you get GitHub's failure email) if CDOT returns no stations, if a station disappears (its id keys the saved status history), or if FMCSA returns more than 20% fewer inspections than before. After reviewing, override with `FORCE=1 npm run sync` / `FORCE=1 npm run sync:inspections`, then commit.

To change the schedule, edit the `cron` line. Bot commits go straight to `main`; if you later add branch protection, allow the Actions bot to bypass it or change the job to open a pull request.

## Security

- **Token check** is constant-time. After 10 failed attempts within a minute a client gets `429` (with `Retry-After`) and its token isn't checked again until the window passes.
- **Client identity** for that lockout is the connection address, or the proxy's `X-Real-IP` when `TRUST_PROXY=1`. The deploy script sets it only when the container is published on `127.0.0.1`, where only the local reverse proxy can reach it. Don't set it if the app is directly reachable, or callers can spoof the header. Behind a tunnel such as Cloudflare, have the proxy pass the real visitor address (e.g. `CF-Connecting-IP`) as `X-Real-IP`, otherwise every visitor shares one lockout.
- **Headers:** every response has a Content-Security-Policy (scripts and styles only from this origin and unpkg, map tiles only from OpenStreetMap, no framing), `nosniff`, a referrer policy, and a permissions policy; API responses are `no-store`.
- **Third-party assets:** Leaflet loads from unpkg pinned to an exact version with Subresource Integrity hashes, so a tampered CDN file won't run. When bumping Leaflet, update the version and both hashes in `public/index.html`; `npm test` fails if a hash or version pin is missing.
- **Not handled in the app:** HTTPS and HSTS (add `Strict-Transport-Security` at the proxy once it serves HTTPS) and request rate limiting for non-failed traffic (use nginx `limit_req`).

## Importing status

There is no official CSP/CDOT open/closed feed (checked CSP's Port of Entry page and COtrip, whose ports-of-entry map layer sits behind an undocumented API), so imports come from adapters you point at a source. Imported entries are tagged with their source and shown as "via <source>" in the UI.

```bash
# CSV or JSON file: columns/keys are station, status, note, updatedAt (see examples/statuses.csv)
npm run import -- --adapter file --path examples/statuses.csv --source csp

# JSON array published at a URL (optionally with a header, e.g. an API key)
npm run import -- --adapter url --url https://example.com/poe.json --header "X-Api-Key: ..."
```

The CLI posts to a running server (`BASE_URL`, default `http://127.0.0.1:3000`; `STATUS_TOKEN` if set), so schedule it with cron for periodic updates.

Rules the importer applies:
- `station` matches a station id or name (`limon`, `Fort Collins`); `status` accepts open/closed/unknown, any case.
- Unknown stations, planned stations, unrecognized statuses and bad or future `updatedAt` values are skipped and reported; the rest of the batch still applies.
- A record older than the current status is skipped, and re-importing identical data changes nothing.
- Without `updatedAt`, the import time is used, so an import overwrites an earlier manual update.

To add a real CSP/COtrip/Drivewyze source later, create `adapters/<name>.js` exporting `async fetchStatuses(options)` that returns `[{ station, status, note?, updatedAt? }]`, and register it in `adapters/index.js`.

## API

- `GET /api/stations` · `GET /api/stations/:id` · `GET /api/stations/:id/history`
- `PUT /api/stations/:id/status` with `{"status":"open|closed|unknown","note":"..."}`
- `POST /api/import` with `{"source":"csp","records":[{"station":"limon","status":"open"}]}` (max 500 records) returns `{updated, unchanged, skipped}`

## Ideas for later

A real CSP/Drivewyze/PrePass adapter if a feed becomes available, per-direction status, and SQLite/Postgres if multiple writers are needed.
