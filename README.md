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

## Architecture

[How it works](#how-it-works) is the overview. This section is the structure behind it: the parts, how they depend on each other, and why they are built this way.

### Four parts

| Part | What | Runs |
|---|---|---|
| **Runtime** | One Node process: HTTP server, status store, static page | In a container on the home server, behind nginx |
| **Data pipeline** | Scripts that turn CDOT and FMCSA data into JSON files committed to git | Weekly on GitHub Actions, or by hand |
| **Delivery pipeline** | Tests, image build, smoke test, publish, deploy, rollback | GitHub Actions, then a self-hosted runner on the server |
| **Operations** | Backup, restore, alerting, heartbeat check | Cron on the server, plus a scheduled workflow in the backup repo |

The parts only meet through files and git: the data pipeline writes `data/*.json`, the delivery pipeline bakes them into an image, and the runtime reads them at startup. Nothing at runtime calls CDOT, FMCSA or GitHub, so those being slow or down never affects the page.

### Runtime

**Modules** (an arrow means "imports"):

```
server.js ─► store.js          status.json: current status per station + capped history
          ─► auth.js           constant-time token check, failed-attempt lockout
          ─► importer.js ─► store.js     validates and applies imported records
          ─► inspections.js            monthly rows ─► per-station summaries, OOS rates
          ─► inspection-locations.js ─► inspections.js     map points filtered by level and period
adapters/ (file, url)  ─ used only by scripts/import-status.js, never by the server
scripts/               ─ standalone; none import server code
```

`createApp(options)` takes every file path (and the token and limiter) as options instead of reading globals, which is what lets the tests run the real server against temporary files.

**A request**
1. Security headers are set on every response, before any routing.
2. The path is matched against the API routes; anything else is served from `public/` (paths are normalized and must stay inside it).
3. A write goes through `authorize`: the client (connection address, or `X-Real-IP` when `TRUST_PROXY=1`) is checked against the lockout, then the token is compared in constant time; failures count toward the lockout.
4. The body is read with a size cap (10 KB; 500 KB for imports), parsed and validated. Bad input is a `400`, an unknown station a `404`, a planned station a `409`, anything unexpected a `500`.
5. Reads are answered from memory: station data merged with the current status and a 12-month inspection summary.

**State.** Everything except status is read-only at runtime and loaded once at startup (about 150 KB in memory). Status is the only mutable data and has a single writer, this process. It is persisted after each change by writing a temp file and renaming it, with writes queued so only one runs at a time (a failed write doesn't block the ones behind it), and read from disk only at startup.

| File | Shape |
|---|---|
| `data/stations.json` | `{ source, fetchedAt, stations: [{ id, name, highway, planned, phone, locations: [{ direction, milepost, lat, lng }] }] }` |
| `data/inspections.json` | `{ source, fetchedAt, through, rows: [{ station, month, level, total, vehicleOos, driverOos }] }` |
| `data/inspection-locations.json` | `{ source, fetchedAt, through, coverage, locations: [{ id, name, kind, lat, lng, levels }] }` |
| `status.json` (volume) | `{ current: { <id>: { status, note, updatedAt, source } }, history: [ ... last 1000 ... ] }` |

A station's `id` (a slug of its name) is the key everywhere: inspections and saved statuses refer to it, which is why the sync refuses to drop a station silently.

### Data pipeline

`scripts/sync-*.js` fetch the public sources, join them to station ids, and write the JSON files, which are committed. Committing generated data is deliberate: a deploy is reproducible, rolling back the image also rolls back the data, changes show up as reviewable diffs, and the runtime has no live dependency on the sources.

- **Joining.** Inspections are matched to a port by town name and fixed-facility flag; map points are placed at a port or at a town centroid from a Census gazetteer (`data/co-places.json`, used only by the scripts and not shipped in the image).
- **Guards.** `scripts/data-file.js` rewrites a file only if the data changed (the fetch time alone doesn't count); the scripts refuse empty results, dropped stations, or sharp drops in counts unless `FORCE=1`.
- **Refresh.** `refresh-data.yml` runs the scripts and tests weekly. If data changed it commits as a bot and dispatches the deploy workflow explicitly, because a push made with the default token doesn't trigger other workflows.

### Delivery

```
push to main ─► test (Node 22) ─► build image ─► boot it, smoke-test ─► publish to GHCR ─► deploy job
                                                                                          │ self-hosted runner, same host
                                           pull :sha-<commit> ─► replace container ─► wait healthy ─► done
                                                                                          └─ unhealthy ─► restore previous image, fail the job
```

Runtime topology: `browser ─► nginx :8080 (LAN) ─► 127.0.0.1:3000 ─► container`, with the `cdot-data` volume mounted at `/var/lib/cdot` and the token in an env file outside the image. Images are tagged with the commit SHA and the deploy uses that tag, so what runs is exactly what was tested. The deploy job runs on a self-hosted runner because the server is on a home network that GitHub's hosted runners can't reach; this avoids SSH keys and open ports.

### Operations

Each failure has a different safety net:

| Failure | Caught by |
|---|---|
| Bad code | Tests, then the image smoke test, before anything is published |
| Image that boots but is broken | Health check after deploy, then automatic rollback |
| Bad upstream data | Sync guards (the weekly job fails instead of committing) |
| Lost or corrupted status | Daily local and off-site backup (validated before saving), restore script |
| Backup fails | A `backup-failed` issue, closed on recovery |
| Backup stops running (server off, cron dead) | A `backup-missing` issue from the daily heartbeat check |

### Design decisions

- **No dependencies, plain `node:http`.** Small surface to patch, nothing to install, tests need no tooling.
- **JSON files, not a database.** Status is a few KB with one writer, so a file is simple to back up, diff and restore. The cost is below.
- **Data baked into the image.** Predictable and fast; the cost is that fresher data means a (automatic) redeploy.
- **Status has a source and a time.** Every update records where it came from (`manual` or an import name), so imports and people can coexist and stale imports can't overwrite newer entries.
- **A shared write token.** Enough for a small trusted group; it is the part to replace first if this goes public.

### Known limits

- **One instance only.** Status is held in memory and read from disk at startup, so two instances would diverge. Scaling out means moving status to a real database.
- **No user accounts or audit of who changed what**, only the source and time.
- **HTTP on the LAN.** HTTPS and HSTS belong at the reverse proxy before the app is public.

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

### Inspection locations on the map

Tick **Show inspection locations on the map** (above the station list) to draw circles for where level I–V inspections happened, sized by count. Pick any combination of levels and either the last 12 months or all available data (about 3 years); click a circle for its level breakdown and out-of-service rates. Purple circles are ports of entry; blue circles are towns. The choices are remembered in the browser.

FMCSA's inspection records have **no coordinates**, only a place description, so each record is placed by `scripts/sync-inspection-locations.js`:

- `LIMON POE WB` / `LAMAR PORT OF ENTRY` and fixed-facility inspections in a port's town go to that port's coordinates (about 67% of inspections);
- `<TOWN> CO` goes to the town's centroid from `data/co-places.json`, built from the US Census gazetteer with `npm run build:places` (about 29%). Roadside stops in a port's town are pinned at the town, or at the port if the gazetteer doesn't list the town (e.g. Dumont);
- the remainder (about 4%: small unincorporated places such as Woodrow, and free-text highway-milepost entries) is **not placed**. The panel reports the placed share, and the API returns it as `coverage`. Three ambiguous place names (Coal Creek, Glendale, Twin Lakes) are deliberately left out rather than guessed.

Town pins mark the town's centre, not the exact roadside spot. `npm run sync:locations` refreshes `data/inspection-locations.json` (it's part of the weekly refresh, with the same safety checks). API: `GET /api/inspection-locations?levels=1,2,3&period=12m|all`.

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

## Troubleshooting

Commands that mention `docker` need a user in the `docker` group. In a session started before you were added, prefix them with `sg docker -c "..."`.

**Container won't start or keeps restarting.** Look at `docker logs --tail 50 cdot-stations`.
- `Refusing to listen on 0.0.0.0 without STATUS_TOKEN`: the container needs the token (`~/cdot-stations/env` on the server, written by the deploy job from the `STATUS_TOKEN` secret). Re-run the deploy, or set `ALLOW_OPEN_WRITES=1` only on a private network.
- `ERR_MODULE_NOT_FOUND`: a source file is missing from the image. The Dockerfile copies every root `*.js` plus specific folders, so a new top-level folder or data file must be added to it. CI's smoke test catches this before anything is published; reproduce it locally with `docker build -t cdot-local . && bash scripts/smoke-test-image.sh cdot-local`.
- A failed deploy rolls back automatically, so the previous version keeps serving. The deploy job's log shows why the new one failed.

**The deploy job is skipped, or waits forever.**
- *Skipped:* the `DEPLOY_ENABLED` repository variable isn't `true` (`gh variable list`). Pull requests never deploy.
- *Queued and never starts:* the self-hosted runner is offline. Check `gh api repos/snowseasons-tech/cdot-stations/actions/runners -q '.runners[] | "\(.name) \(.status)"'` and `systemctl status 'actions.runner.*'` on the server; restart with `sudo systemctl restart 'actions.runner.*'`.
- *`permission denied ... docker.sock`:* the runner's user isn't in the `docker` group (`sudo usermod -aG docker $USER`), then restart the runner service so it picks the group up.

**The page doesn't load from another device.** Check on the server: `ss -ltn | grep 8080` (is nginx listening), `sudo nginx -t`, and the firewall (`sudo ufw allow 8080/tcp`). The server's address comes from DHCP and can change, so check `ip -4 addr` and consider a reservation in your router. `curl localhost:8080/api/stations` working but other devices failing points at the firewall or the address.

**Status updates are rejected.**
- `401`: wrong or missing token. The server's copy is in `~/cdot-stations/env`. GitHub secrets can't be read back, so to rotate it run `openssl rand -hex 32 | gh secret set STATUS_TOKEN` and re-run the deploy workflow.
- `429`: 10 failed attempts within a minute lock a client out until `Retry-After` passes. Behind nginx the client is identified by `X-Real-IP`, so one person's typos don't lock out others.
- `409`: the station is planned (Platteville) and can't have a status.

**Statuses disappeared after a deploy or restart.** They live in the `cdot-data` Docker volume. Check `docker volume ls | grep cdot-data` and that the container was started with `-v cdot-data:/var/lib/cdot` (the deploy script does this). If they are gone, restore the latest backup (see Backups).

**The map is blank or unstyled.** Open the browser console.
- A *CSP* or *integrity* error means a CDN file changed or a header was tightened. After changing the Leaflet version, update both integrity hashes in `public/index.html` (`npm test` checks they exist).
- Tiles load from OpenStreetMap and need internet access and a Referer; don't set a `no-referrer` policy.

**Inspection numbers look old or low.** The newest month is partial (FMCSA data arrives late). Check `through` in `data/inspections.json`, and run the refresh on demand: `gh workflow run refresh-data.yml`. A refresh that fails with `refusing to overwrite` or `more than 20% fewer` is the safety net working: look at the source, and if the new data is right, run `FORCE=1 npm run sync:inspections` (or `sync:locations`, `sync`) locally, review the diff, and commit. `CDOT's layer no longer lists ...` means a station disappeared from CDOT's layer; its id keys saved statuses, so confirm before forcing.

**Backups.** Read `~/cdot-stations/backup.log` first.
- `no status file yet; nothing to back up` is normal until the first status is saved.
- `cannot reach a running container named cdot-stations`: the container is down, or cron's user can't use docker. Check `docker ps` and `crontab -l`.
- `NOT backing it up`: `status.json` isn't valid; restore from the last good backup.
- No log lines for days: cron isn't running (`systemctl is-active cron`). The `backup-missing` issue in the backup repo will say so after about 30 hours.
- Local copies appear but the off-site push fails: the `gh` login expired (`gh auth status`, then `gh auth login`).

To restore, see Backups; to stop the alerts temporarily, set `ALERT_REPO=""` in the cron line.

## Testing

There are four layers, from fast and local to slow and realistic.

| Layer | Run it | What it covers |
|---|---|---|
| Unit and API tests (43) | `npm test` | Starts the real server on a random port with temp files and calls it over HTTP, plus pure-function tests. No network, no Docker; takes a few seconds. |
| Backup end-to-end | `bash test/e2e/backup.sh` | Backup, retention pruning, refusal of corrupt data, restore and the heartbeat, against a throwaway container and a local git repo. Needs Docker, `jq` and `git`; leaves the real deployment untouched. |
| Image smoke test | `docker build -t cdot-local . && bash scripts/smoke-test-image.sh cdot-local` | Boots the built image and checks it becomes healthy, serves the page and API (including inspection data) and enforces the write token. CI runs it before publishing. |
| Post-deploy health check | automatic | The deploy script waits for the container's health check and rolls back if it fails. |

**What the unit tests cover** (`test/*.test.js`): the API and storage (`api`), status import and CSV parsing (`import`), inspection summaries and out-of-service rates (`inspections`), the inspection-locations map data (`inspection-locations`), token checking, lockout, security headers and integrity hashes (`security`), the sync scripts' change detection and guards (`refresh`), and backup and heartbeat alerting using a fake `gh` (`alerts`).

**Writing tests**
- Use Node's built-in runner (`node:test`, `node:assert/strict`); no test framework is installed.
- API tests start the server with `createApp()` on port 0 and register cleanup with `t.after(...)` so a failed assertion can't leave a server running and hang the suite.
- Pass temp file paths to `createApp` (`statusFile`, `inspectionsFile`, ...) instead of touching `data/`. Don't call live services (CDOT, FMCSA, GitHub) from `npm test`; test the parsing and guard logic with sample data.
- Shell scripts are tested by running them with stubs on `PATH` (see `test/alerts.test.js`, which fakes `gh`) or against a throwaway container (`test/e2e/backup.sh`).
- When you change a safety check, break it on purpose once and confirm a test fails.

**CI.** Pushes and pull requests run `npm test` on Node 22; pushes to `main` continue to the image smoke test, publish and deploy. The weekly data-refresh workflow runs the tests before it commits new data.

## Contributing

**Setup.** Node 20 or newer; there is nothing to install (the app has no npm dependencies). `npm start` runs it on `127.0.0.1:3000`, `npm test` runs the suite (the Docker-based backup test, `bash test/e2e/backup.sh`, is separate and needs Docker).

**Keep it dependency-free.** The server, scripts and tests use only Node's standard library, and the page is plain JavaScript with Leaflet loaded from a CDN. Think twice before adding a package: it has to be copied into the image and kept patched.

**Workflow.** Every push to `main` that passes the tests is published and deployed to the server, so treat `main` as production.
1. Make the change and run `npm test`. Add a test alongside the code (`test/*.test.js`); bug fixes should come with one that fails without the fix.
2. If users or operators would notice the change, add a line under *Unreleased* in [CHANGELOG.md](CHANGELOG.md), and update the README section it affects.
3. Commit with a message that says what and why. Push, then watch the Actions run: it tests, boots the built image as a smoke test, publishes it, and deploys it with automatic rollback.

**Things that are easy to get wrong**
- *New files and the Docker image.* The Dockerfile copies root `*.js` files and specific folders and data files. A new top-level folder or data file must be added there, or the container won't start (the smoke test will tell you).
- *Data files* (`data/stations.json`, `inspections.json`, `inspection-locations.json`) are generated by the `sync` scripts and refreshed weekly by a bot commit. Don't edit them by hand. `data/status.json` is runtime data and is never committed.
- *Status writes* must go through the server (UI, API or an importer), never by editing `status.json`, which the app reads only at startup.
- *Changing Leaflet or any third-party asset:* pin an exact version and update its integrity hash in `public/index.html`; a test enforces this. Keep the Content-Security-Policy in `server.js` as tight as the page allows.
- *Shell scripts* run on the server unattended. Make failures loud (`set -euo pipefail`, a non-zero exit, a clear message): a script that quietly does nothing is worse than one that fails.

**Adding a status source.** Create `adapters/<name>.js` exporting `async fetchStatuses(options)` that returns `[{ station, status, note?, updatedAt? }]`, register it in `adapters/index.js`, and add a test. The importer already handles validation, ordering and de-duplication.

**Working in parallel.** If another person or session is editing the same checkout, stage files by name (`git add <paths>`, not `git add -A`) so you commit only your own changes.

## Changes

See [CHANGELOG.md](CHANGELOG.md). Add an entry under *Unreleased* when you change something users or operators would notice.

## Ideas for later

A real CSP/Drivewyze/PrePass adapter if a feed becomes available, per-direction status, and SQLite/Postgres if multiple writers are needed.
