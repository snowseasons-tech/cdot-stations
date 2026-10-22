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

Pushing to `main` runs `.github/workflows/deploy.yml`: tests first, then it builds the Docker image and publishes it to GitHub Container Registry as `ghcr.io/snowseasons-tech/cdot-stations` (tags `latest` and the commit SHA). Pull requests only run the tests. The package is private by default, so the host needs a token with `read:packages` to pull it.

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

On pushes to `main`, once the image is published, the `deploy` job SSHes to your server, pulls the exact commit's image (`sha-<commit>`), replaces the `cdot-stations` container, and waits for its health check. If the new container isn't healthy it restores the previous image and the job fails. The job is skipped until `DEPLOY_HOST` is set, and you can re-run it from the Actions tab.

Server needs Docker, and an SSH user that can run `docker` (e.g. in the `docker` group). The container publishes `127.0.0.1:3000` by default for a reverse proxy on the same machine to forward to.

One-time setup (run these yourself; the secrets never pass through anyone else):

```bash
# 1. A dedicated deploy key; add the .pub to ~/.ssh/authorized_keys for the deploy user on the server
ssh-keygen -t ed25519 -f deploy_key -N "" -C cdot-stations-deploy

# 2. Pin the server's host key. Compare the fingerprint with the server's before trusting it.
ssh-keyscan -p 22 your.server.example > known_hosts && ssh-keygen -lf known_hosts

# 3. Repository variables (not secret) and secrets
gh variable set DEPLOY_HOST --body your.server.example
gh variable set DEPLOY_USER --body deploy
gh secret set DEPLOY_SSH_KEY < deploy_key
gh secret set DEPLOY_KNOWN_HOSTS < known_hosts
openssl rand -hex 32 | gh secret set STATUS_TOKEN   # the write token; read it back from the server's ~/cdot-stations/env
```

Optional variables: `DEPLOY_PORT` (SSH port, default 22) and `DEPLOY_PORT_MAPPING` (default `127.0.0.1:3000:3000`; use `0.0.0.0:3000:3000` if the proxy runs on another host). The job uses a GitHub environment named `production`; GitHub creates it on first run, and you can add required reviewers to it for manual approval.

The token is written to `~/cdot-stations/env` (mode 600) on the server and passed to the container with `--env-file`, never on a command line.

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
