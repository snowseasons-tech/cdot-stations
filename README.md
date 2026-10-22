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

## Performance

The app is small and fast enough that performance is not a concern at this scale. These are measurements, not guarantees: October 2026, Node 22, a 16-core home server, `ab` (ApacheBench) running on the same machine, against a temporary instance (not production). Treat them as orders of magnitude.

**Reads** (5,000 requests, 50 concurrent, straight to the app):

| Endpoint | Requests/s | p50 | p99 |
|---|---|---|---|
| `GET /` (the page) | 4,300 | 11 ms | 23 ms |
| `GET /api/stations` | 3,600 | 14 ms | 17 ms |
| `GET /api/stations/limon` | 7,000 | 7 ms | 8 ms |
| `GET /api/stations/limon/inspections?months=36` | 6,200 | 8 ms | 11 ms |
| `GET /api/inspection-locations` (all levels, all time) | 1,400 | 35 ms | 45 ms |

Node is single-threaded, so at 50 concurrent requests most of that latency is queueing: at 10 concurrent, `/api/stations` is about 4 ms and the locations endpoint about 10 ms. Through nginx the numbers are the same within noise (production, 10 concurrent: 2,281 req/s with nginx vs 2,174 direct). The slowest endpoint does the most work, filtering and serializing 277 map points (106 KB).

**Writes** go through the status queue, with one temp-file rename each:

| Case | Writes/s | Latency |
|---|---|---|
| One at a time, empty history | ~1,700 | ~1 ms |
| One at a time, history at its 1,000-entry cap (158 KB file rewritten each time) | ~860 | ~1 ms |
| 50 concurrent, history full | ~1,000 | p50 48 ms, p99 54 ms, none failed |

**Footprint.** Starts serving in about 200 ms. Process memory (RSS) was 73 MB idle, 97 MB after 10,000 heavy reads and 110 MB after 1,500 writes; this wasn't a long-running leak test. Docker reports far less for the container (about 16 MiB) because it doesn't count file-backed pages, so compare like with like. The image is 239 MB, mostly the Node base image.

**What a visitor downloads** (bytes; "gzip" is the response gzipped by hand, for comparison):

| Resource | Raw | Gzip |
|---|---|---|
| `/`, `app.js`, `styles.css` together | 17 KB | 6 KB |
| `/api/stations` | 9.8 KB | 2.0 KB |
| `/api/stations/:id/inspections` | 1.4 KB | 0.4 KB |
| `/api/inspection-locations` (all levels, all time) | 106 KB | 15 KB |
| Leaflet from unpkg (not from this server) | 148 KB JS + 15 KB CSS | n/a |

With nginx compression enabled (see below) a visitor receives the gzip column from this server.

**Load in practice.** Each open page polls `/api/stations` once a minute (about 10 KB), so 100 open tabs is under 2 requests per second against a capacity in the thousands. The page is never the bottleneck; the design limit is the single instance (see Architecture), not speed.

**Delivery speed.** A push is live in about 70 to 95 seconds: tests about 10 s, image build, smoke test and publish about 40 to 60 s, deploy about 14 s (one run in six took 161 s).

### Compression, and known inefficiencies

**Compression is configured in `deploy/nginx-cdot-stations.conf`** (gzip for JSON, JavaScript and CSS, level 5). nginx's default only compresses HTML, so before this the 106 KB locations response crossed the network uncompressed. Measured against the live app, with compression it sends 15.6 KB (7x less), `app.js` 3.5 KB (from 9.8), `/api/stations` 2.0 KB (from 9.8). It costs no measurable throughput because the app, not nginx, is the bottleneck, and clients that don't ask for gzip still get plain responses. It takes effect on the server once you re-run `bash scripts/install-nginx-site.sh`.

Not fixed, in order of value:
1. **Static files have no `Cache-Control`, `ETag` or `Last-Modified`**, so every page load refetches the ~17 KB (about 6 KB compressed). Cheap to add if it ever matters.
2. **Summaries are recomputed on every request** (about 1,000 rows filtered per station), although the data is read-only at runtime. A cache would be trivial and is unnecessary at this traffic.

### Measuring it yourself

```bash
PORT=3105 STATUS_TOKEN=t STATUS_FILE=/tmp/perf-status.json node server.js &
echo $! > /tmp/perf.pid
ab -q -n 5000 -c 50 http://127.0.0.1:3105/api/stations
echo '{"status":"open"}' > /tmp/body.json
ab -q -n 1000 -c 1 -u /tmp/body.json -T application/json -H 'authorization: Bearer t' http://127.0.0.1:3105/api/stations/limon/status
kill $(cat /tmp/perf.pid); rm /tmp/perf-status.json
```

Benchmark a temporary instance, not the production container, and stop it by PID: `pkill -f "node server.js"` also matches the container's process on the server.

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

The site also gzips JSON, JavaScript and CSS. It leaves the existing port-80 default site alone and removes the new site again if `nginx -t` fails. Then open **http://192.168.0.20:8080** (the server's wired address; the Wi-Fi address `192.168.0.91` works too). Both come from DHCP and can change, so a reservation in your router keeps them stable. If another device can't connect, check the firewall (`sudo ufw allow 8080/tcp`).

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

**Threat model.** A small internal tool. Station data comes from public sources, so reading is open; what needs protecting is the integrity of the status data (nobody but the team should be able to change it) and the people using the page. It is served over plain HTTP on a home network today, and is built so it can be exposed publicly later: see "Before making it public".

### What protects what

| Asset | Controls |
|---|---|
| **Status data** (who can change it) | Writes (`PUT .../status`, `POST /api/import`) need a bearer token, compared in constant time. After 10 failed attempts in a minute a client gets `429` and its token isn't checked again until the window passes. The server refuses to listen on a non-local address without a token. Input is validated (status must be open/closed/unknown, notes up to 280 characters, body size capped at 10 KB, 500 KB for imports), and for manual updates the server sets the source and time itself, so a caller can't forge them (an import may supply its own timestamp, but never one in the future, and it can't overwrite a newer status). |
| **People using the page** (XSS and injection) | Notes and station names are put on the page as text, never as HTML. A Content-Security-Policy allows scripts only from this origin and unpkg (no inline scripts), connections only to this origin, and no framing; plus `nosniff`, a referrer policy and a permissions policy. API responses are `no-store`. Reads use no cookies, so there is no CSRF exposure: the token is sent in a header by the page's own code. |
| **Files on the server** | Static files are served only from `public/` (paths are normalized and must stay inside it). |
| **Third-party code** | Leaflet loads from unpkg at an exact version with Subresource Integrity hashes, so a tampered file won't run (`npm test` enforces the pin and hashes). The app itself has no npm dependencies to compromise. |
| **Secrets** | The token lives in a GitHub secret, in `~/cdot-stations/env` on the server (mode 600), and is given to the container through `--env-file`, never on a command line or in the image. There are no SSH keys or cloud credentials: deploys use a runner on the server and the workflow's own short-lived token, and the registry login is removed after each deploy. |
| **The container** | Runs as a non-root user, is published only on `127.0.0.1` (only the local nginx can reach it), and is health-checked. |
| **Backups** | Go to a private GitHub repository. They contain only statuses and notes, nothing credential-like, but anything typed into a note is in them. |

**Untrusted input.** CDOT, FMCSA and the Census gazetteer are treated as untrusted: the weekly refresh refuses implausible data (empty, dropped stations, sharp drops), and anything from them, or typed by a user, is displayed as text. The page never gives Leaflet a string for a popup or tooltip (Leaflet would render it as HTML), only DOM nodes, and a test fails if that changes. This was once not the case for the map's hover tooltip; with a place name containing `<img ...>` it created a real element, and it was fixed by passing a text node.

### Client identity and the lockout

The lockout identifies a client by connection address, or by the proxy's `X-Real-IP` when `TRUST_PROXY=1`. The deploy script sets it only when the container is published on `127.0.0.1`, where only the local reverse proxy can reach it. Don't set it if the app is directly reachable, or callers can spoof the header. Behind a tunnel such as Cloudflare, have the proxy pass the real visitor address (for example `CF-Connecting-IP`) as `X-Real-IP`, otherwise every visitor shares one lockout.

### Trust assumptions to know about

- **One shared token, no accounts.** Anyone holding it can change any status; there is no record of who did. It is stored in the browser's `localStorage` once entered, so an XSS bug would expose it (the CSP is the main defence).
- **The self-hosted runner executes this repository's workflow code on the server.** Anyone who can push to `main` or edit a workflow can run commands there. Keep the repository private and its write access small. Only the deploy job uses the runner, and pull requests never deploy.
- **Docker access is root-equivalent.** Users in the `docker` group (including the runner's user) can read the token from the container's environment.
- **GitHub Actions are pinned to major versions** (`@v4`), not commit SHAs, and the base image is `node:22-alpine` without a digest. That trades supply-chain strictness for automatic security updates.
- **The host runs other services.** Check `ss -ltn` on the server: anything listening on all interfaces must not be reachable from the internet.

### Before making it public

1. **HTTPS and HSTS** at the reverse proxy (a Cloudflare Tunnel or Let's Encrypt), and drop the plain-HTTP port. The token must never cross the network unencrypted.
2. **Expose only the proxy**: forward or tunnel one port, not the machine. Confirm with `ss -ltn` what else listens on all interfaces.
3. **Rate limit at nginx** (`limit_req`) for all traffic, not just failed tokens, and pass the real client address as `X-Real-IP`.
4. **Replace the shared token** with per-person logins if more than a few people will write, and rotate it before launch.
5. **Consider pinning Actions and the base image by digest**, with automated update PRs.
6. **Protect `main`** with required checks (letting the data-refresh bot through) so a stray push can't deploy.

### Rotating the token, or responding to a leak

```bash
openssl rand -hex 32 | gh secret set STATUS_TOKEN    # then re-run the deploy workflow
```

The deploy rewrites `~/cdot-stations/env` and restarts the container with the new value; update anything that calls the API (importers). Old tokens stop working immediately. Rotate whenever someone who knew it leaves, or if it may have been exposed.

## Inspection locations on the map

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

## FAQ

**Is the open/closed status live?** No. Neither CSP nor CDOT publishes a status feed (checked CSP's Port of Entry page and COtrip), so a station shows `unknown` until someone reports it, and it is only as current as the last update or import. The card shows when it was updated and by whom or what.

**Can I rely on it for trip or compliance decisions?** No. This is an unofficial tool, not affiliated with CDOT, CSP or FMCSA. Status is whatever the team entered, and the inspection figures come from public FMCSA files that lag. To check a port, call its number (shown on each card) or CSP.

**Why only 10 stations, and why is Platteville "planned" but has inspections?** The list is CDOT's public ports-of-entry layer. Platteville is listed there as a future site, but FMCSA has a few hundred inspections at "PLATTEVILLE CO" in fixed-facility records (sporadic, likely temporary operations), so they show.

**What are the out-of-service (OOS) rates?** The share of inspections that found at least one out-of-service violation. The vehicle rate counts only inspections that covered the vehicle (Levels I, II, V, VI) and the driver rate only those that covered the driver (I, II, III, VI), matching how FMCSA reports them, so the two rates have different denominators.

**Why doesn't the total on a station card match the map layer?** A card counts inspections *at that port* (fixed-facility records, last 12 months). The map layer counts all Colorado inspections it could place, including roadside patrol stops in towns, so its total is larger.

**The latest month looks low. Is something wrong?** No: FMCSA data arrives late, so the newest month is partial. It fills in over the following weeks.

**Why aren't some inspections on the map?** FMCSA records carry no coordinates, only a place name. About 4% are small places or free-text entries that can't be placed reliably, and the page shows the placed share. See "Inspection locations on the map".

**Who can update a status, and what if I lost the token?** Anyone with the token, from "Update status" on a card, the API, or the importer. The server's copy is in `~/cdot-stations/env`; GitHub secrets can't be read back, so otherwise rotate it (see Security).

**How often does the data refresh?** Station locations and inspection data refresh automatically every Monday at 06:17 UTC, and only changed data is committed and deployed. Run it now with `gh workflow run refresh-data.yml`.

**Can I add a station or fix a phone number?** Not by hand: stations come from CDOT's layer and an edit to `data/stations.json` would be overwritten at the next refresh. There is no override mechanism yet; if CDOT's data is wrong or incomplete, that is a feature to add.

**Does it work on a phone?** Yes, the layout adapts to narrow screens. For now it is only reachable on your home network, at `http://192.168.0.20:8080`. A proper mobile app is planned (see the Roadmap).

**Does it work offline?** The server needs no internet (it never calls CDOT, FMCSA or GitHub while running). The page does: Leaflet loads from unpkg and map tiles from OpenStreetMap.

**What happens after a power cut or reboot?** Docker, nginx, cron and the deploy runner all start at boot, and the container restarts itself, so it comes back without help. Statuses are on a volume and survive. A backup due while the machine is off is missed; if it stays off, the heartbeat check raises an issue after about 30 hours.

**How do I reset or wipe the statuses?** Restore an empty file. It saves the current data first, so it can be undone:
```bash
echo '{"current":{},"history":[]}' > /tmp/empty.json && bash scripts/restore-status.sh /tmp/empty.json
```

**How do I get the data out?** The read API is open: `curl http://192.168.0.20:8080/api/stations` (stations, status and 12-month inspection summaries), `/api/stations/limon/inspections?months=36`, `/api/stations/limon/history`, and `/api/inspection-locations?levels=1,2,3&period=all`. All JSON.

**Can it pull status from CSP, Drivewyze or PrePass?** There is no official feed to pull from. If you find one, it is one small adapter (see Contributing). The app doesn't track wait times or bypass programs; use a note on the status.

**What time zone are times in?** Stored in UTC. The page shows relative times ("12 min ago") and your browser's local date for older updates.

**How do I run it on my own computer?** `git clone`, then `npm start` and open `http://127.0.0.1:3000`. Node 20 or newer, nothing to install.

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

## Roadmap

Proposals, not commitments, in rough order of value and urgency. Each says where it came from so it can be re-judged. When one ships, move it to [CHANGELOG.md](CHANGELOG.md) and delete it here.

### Soon: small and worth doing

1. **Know when the site is down.** Nothing alerts if the app stops responding between deploys. The daily backup fails loudly when the container is unreachable, so an outage is noticed within a day, but not sooner. A cron probe of `/api/stations` that opens an issue (or an external uptime check) closes the gap.
2. **Show status history on the page.** `GET /api/stations/:id/history` already returns the last 50 changes, but the UI doesn't display them.
3. **A browser check in CI.** The tests don't run the page. A headless check of the built image (page loads, map and layer draw, no console or CSP errors) would have caught CSP regressions automatically instead of by hand.
4. **Cache headers on static files** (`ETag` / `Cache-Control`), so repeat visits don't refetch the page's ~17 KB (see Performance).

### Before it goes public

From the Security checklist; these are required, not optional, before exposing the app to the internet.
- HTTPS and HSTS (a Cloudflare Tunnel or Let's Encrypt) and removing the plain-HTTP port.
- nginx `limit_req` and the real client address passed as `X-Real-IP`.
- Per-person logins in place of the shared token, with a record of who changed what.
- Branch protection with required checks (letting the data-refresh bot through).
- Pinning GitHub Actions and the base image by digest, with automated update PRs.

### Planned: mobile app

A mobile app is wanted, for the team only, on **iPhone and Android**, hosted by the team itself. It needs to work **with a signal** (no offline mode), should **notify the team when a station changes**, and starts **read-only, with updating statuses from the phone wanted later**. The page already works in a phone browser (responsive layout), so this is about what a browser tab can't do: sitting on the home screen and notifying people.

**What the decisions mean**
- **Self-hosted, team only: no app stores.** Nothing is published to or reviewed by Apple or Google; people install it from a link.
- **Both platforms: build it as an installable web app (PWA).** One codebase covers iPhone and Android. Native apps would mean two, and nothing here needs them.
- **Online only: the offline work is minimal.** A small service worker makes it installable and caches the page shell; no data syncing or offline queue is needed.
- **Read-only first: no logins needed yet.** The read API is open and carries no secrets, so no write token goes on anyone's phone. Per-person logins become a prerequisite only for updating statuses from the phone.
- **Notifications don't need that either.** Statuses are updated from the web page or by importers, so phones can be notified of changes without being able to make them.
- **A phone away from home still has to reach the server.** `192.168.0.20` only works on the home network, and push notifications only work over HTTPS. Because the audience is a known team, the server needn't be open to the whole internet: a Cloudflare Tunnel with Cloudflare Access (team members sign in by email) or a private network such as Tailscale gives HTTPS and reach from anywhere without exposing it publicly. That is cheaper and safer than the full "go public" list above, and it is the real prerequisite for everything else here. The "Before it goes public" items matter if it is opened to everyone instead.

**Plan**
1. **Reach the server from anywhere:** a Cloudflare Tunnel with Cloudflare Access (decided; details below), over HTTPS.
2. **Installable web app, read-only.** A manifest and a minimal service worker on the existing page: installs to the home screen from a link and opens full-screen. This is a complete first version on its own.
3. **Notifications (web push).** Decided: **a saved change to a station's status or note notifies its followers, and nothing else does** (a new inspection summary, a data refresh or a map update never does) (re-importing identical data changes nothing, so it doesn't). People **follow stations** from the app, one at a time or all of them. Needs, in order:
   - *Change events on the server.* The status store already knows the previous entry when it saves a new one, so it emits an event for each station that changed. Narrowing this later (for example to open/closed flips only) is a small change.
   - *Subscriptions.* Each phone registers a push subscription and the stations it follows. Keep them in their own file on the status volume (so restoring statuses doesn't wipe who is subscribed), include that file in the backup, and drop a subscription when the push service reports it gone. The subscribe endpoint is a new unauthenticated write, so it needs a rate limit and a cap on total subscriptions, or to sit behind the team sign-in from step 1.
   - *Sending.* Web push needs VAPID keys (a new secret, stored like the token) and encrypted delivery. **Decided: the `web-push` package** (see below).
   - *In the app:* a follow button per station, an "all stations" shortcut, and an unfollow.
4. **Updating statuses from the phone.** Needs per-person logins and the status history on the page first, so changes are attributable. This is the "want to change that" step.
5. **Native wrapper (Capacitor) or native apps** only if a PWA turns out not to be enough.

**Known platform constraints.** On Android, Chrome supports install and push directly. On iPhone, web push works only for a web app **added to the Home Screen** on iOS 16.4 or newer, and the user must grant permission from a tap inside the installed app. So iPhone users need to be guided, and anyone on an older iPhone won't get notifications until they update.

**Telling people about the iPhone install steps: decided to do it in three places**, so nobody has to remember anything:
1. **In the app itself.** When the page is opened in a browser tab on an iPhone (not yet installed), show a dismissible card at the top: "Install this app to get notifications", with the steps below and a picture of the Share button. When it is opened from the Home Screen the card disappears, and the follow button asks for notification permission (that tap is what iOS requires). On an iPhone older than iOS 16.4, say so plainly ("update iOS to get notifications"); on Android show the browser's own install prompt.
2. **A one-page guide** in the repo (`docs/install.md`, with screenshots) that the team lead can link to.
3. **A message to send the team** when it launches, with the link and the same steps. A draft:

> Our station tracker is now an app. On your iPhone: open **<link>** in **Safari**, tap the **Share** button, choose **Add to Home Screen**, tap **Add**. Then open it from the new icon on your Home Screen (not from Safari), open a station, tap **Follow**, and allow notifications. Android: open the link in Chrome and tap **Install**. You need iOS 16.4 or newer for notifications on iPhone.

**Decided: reach the server through a Cloudflare Tunnel protected by Cloudflare Access.** The tunnel makes an outbound connection from the server to Cloudflare, so no router ports are opened and the home IP stays hidden; Cloudflare provides the HTTPS certificate; and Access puts a sign-in in front of the whole site, so only listed team members (by email) can reach it. Nothing to install on phones, and people sign in again only now and then. (Tailscale was the alternative; it needs its app running on every phone.)

**What it needs from you:** a hostname on a domain that is on Cloudflare, and a Cloudflare account (the free plan covers a small team on Access). **No domain needs to be bought:** `snowseasonstech.store` and `snowseasonstech.net` already use Cloudflare's nameservers (per a public DNS lookup), so a subdomain of either, such as `stations.snowseasonstech.net`, costs nothing and takes minutes to add. Things to keep in mind when choosing:
- **Pick the hostname.** It appears in the install link and the team message. Use a subdomain, not the bare domain, so the store is untouched.
- **Zone-wide Cloudflare settings apply to the whole domain**, including the store. In particular, don't switch on HSTS with "include subdomains" without thinking it through. An Access policy, by contrast, applies only to the hostname it is created for.
- **Choosing the team's email addresses** and how long a sign-in lasts are your decisions in Cloudflare's dashboard (Zero Trust, then Access). I can prepare the server-side config and docs, but the account, the DNS record and the Access policy are yours to set up, since they involve your credentials.
- **If you'd rather keep this separate from the store,** buy a cheap domain instead (Cloudflare Registrar sells at cost); that is a purchase for you to make.

**What it changes in this app**
- **Where it points:** `cloudflared` on the server forwards the public hostname to nginx (`http://localhost:8080`), which already forwards to the app. HSTS can then be set at Cloudflare.
- **Real client address:** requests arrive from Cloudflare, so nginx should pass the visitor's address from the `CF-Connecting-IP` header as `X-Real-IP` (only for requests that came from the tunnel), or the lockout and any rate limit treat everyone as one client.
- **Sessions expire:** when an Access sign-in lapses, the page's API calls get a sign-in page instead of JSON. The app must detect that (a non-JSON response) and send the person to sign in again instead of showing a broken page. The service worker must not cache those responses.
- **Keep the LAN route:** the home-network address keeps working, and the importer and backup scripts keep using it, so they don't need to pass through Access.
- **Write protection stays.** Access decides who can *open* the site; the write token (later, per-person logins) still decides who can *change* a status.

### Later: features

- **A real status source.** The biggest gap is that status is manual. Ask CSP's Port of Entry office and CDOT's COtrip team whether a feed or API exists (contact details from public listings, so verify them: CSP Port of Entry Branch, Golden office, 303-273-1870; COtrip, cdot_cotrip@state.co.us). If one exists it is a single adapter (see Contributing).
- **Per-direction status.** Most ports have separate eastbound/westbound or northbound/southbound facilities that can open and close independently; today a port has one status.
- **Email notifications.** Email when a station flips between open and closed, for people who don't use the app (phone notifications are covered under "Planned: mobile app").
- **Station overrides.** A persisted way to correct a phone number or add a note that survives the weekly sync (today edits to `data/stations.json` are overwritten).
- **Trends.** Out-of-service rates over time and comparisons between ports; a CSV export of the inspection data.
- **Better map placement.** About 4% of inspections can't be placed because FMCSA gives only a place name; free-text highway-milepost entries could be matched to the stations' mileposts.
- **A real datastore.** SQLite (or Postgres) if more than one instance or heavy concurrent writes are ever needed; today status is a JSON file read once at startup, which is why the app runs as a single instance.

### Not planned

Wait-time estimates and PrePass/Drivewyze bypass data (no public feed was found; those services show status inside their own apps), and public user accounts.

