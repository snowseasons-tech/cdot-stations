# CDOT Inspection Stations

[![Test and publish image](https://github.com/snowseasons-tech/cdot-stations/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/snowseasons-tech/cdot-stations/actions/workflows/deploy.yml)

Map and list of Colorado's commercial vehicle inspection stations (CSP/CDOT ports of entry), with a manually maintained open/closed status, notes, and history.

```bash
npm start            # http://127.0.0.1:3000
npm test
npm run sync         # refresh data/stations.json from CDOT
npm run sync:inspections   # refresh data/inspections.json from FMCSA
```

## Data

- **Locations** come from CDOT's public [POELocations](https://services.arcgis.com/yzB9WM8W0BO3Ql7d/ArcGIS/rest/services/POELocations/FeatureServer) layer (last published 2019). Platteville is flagged as planned.
- **Status** is *not* live. No official open/closed feed was found, so status is entered by hand and stored in `data/status.json` (gitignored), with the last 1000 changes kept as history.

## Config

| Env var | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Bind address |
| `STATUS_TOKEN` | unset | If set, `PUT /api/stations/:id/status` requires `Authorization: Bearer <token>` |

Set `STATUS_TOKEN` before exposing this beyond localhost.

## Inspections (North American Standard)

`data/inspections.json` holds monthly counts per port and inspection level (I–VII), with vehicle and driver out-of-service (OOS) counts, aggregated from FMCSA's public [Vehicle Inspection File](https://data.transportation.gov/d/fx4q-ay7w) (no API key; FMCSA publishes about three years and updates daily). Run `npm run sync:inspections` to refresh it, e.g. monthly.

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
