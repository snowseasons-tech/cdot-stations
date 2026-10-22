# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Nothing has been tagged or released yet (`package.json` says `0.1.0`, but no version has been cut), so everything so far is under Unreleased. Every push to `main` that passes the tests is deployed. When you cut the first release, rename Unreleased to `[0.1.0] - <date>` and start a fresh Unreleased section above it.

## [Unreleased]

### Added

**Stations and map**
- Map and list of Colorado's 10 commercial vehicle inspection stations (CSP/CDOT ports of entry) with highway, mileposts, travel directions and phone numbers, taken from CDOT's public ports-of-entry layer. Platteville is shown as a planned site.
- Open / closed / unknown status per station with an optional note, the time of the update and its source, plus a history of the last 1000 changes. Updated from the page ("Update status") or the API.
- `npm run sync` to refresh the station list from CDOT.

**Status import**
- `POST /api/import` and `npm run import` to bring in statuses from other sources, with adapters for CSV/JSON files and JSON URLs. Imports are validated, skip bad or older records, ignore unchanged ones, and are tagged with their source. No official CSP/CDOT open/closed feed exists, so this is how one would be plugged in.

**North American Standard inspections**
- Monthly inspection counts per port and level (I–VII) with vehicle and driver out-of-service rates, from FMCSA's public Vehicle Inspection File. Shown on each station card and in an Inspections dialog (by level and by month, 12/24/36 months), and available at `GET /api/stations/:id/inspections`.
- `npm run sync:inspections` to refresh the data.
- Map layer showing where Level I–V inspections happened, as circles sized by count, filterable by inspection level and by period (last 12 months or all). FMCSA records carry no coordinates, so each is placed at its port (for port and fixed-facility records) or at the centroid of its town (Census gazetteer); about 4% can't be placed, and the page shows what share was. Available at `GET /api/inspection-locations`, and refreshed with the weekly data refresh.

**Deployment and operations**
- Docker image, built and published to GitHub Container Registry by GitHub Actions on every push to `main` after the tests pass. The image is booted and checked (home page, API, token enforcement) before it is published.
- Automatic deploy to the home server through a self-hosted runner: health-checked, with automatic rollback to the previous image if the new one doesn't come up healthy.
- nginx site (`deploy/nginx-cdot-stations.conf`) forwarding LAN port 8080 to the app.
- Weekly data refresh workflow: re-fetches CDOT and FMCSA data (including the inspection locations) and, only when it changed, commits it and triggers a deploy. The sync scripts refuse empty results, dropped stations, or more than 20% fewer inspections.
- Daily backup of the status data to a local folder (30-day retention) and to a private GitHub repository, with a restore script.
- Alerts for backups through GitHub issues: one when a backup fails, and one when no backup has arrived for over 30 hours (server off, cron stopped).

### Security
- Write endpoints require a bearer token (`STATUS_TOKEN`). The token is compared in constant time, and a client is locked out for a minute after 10 failed attempts. The server refuses to listen on a non-local address without a token.
- Content-Security-Policy and other security headers on every response; API responses are not cacheable.
- Leaflet is loaded from a CDN with a pinned version and Subresource Integrity hashes.
- Manual status updates accept only a status and a note; the source and timestamp are always set by the server.

### Known limitations
- Status is not live; it is only as current as the last manual update or import.
- Served over plain HTTP on the home network. HTTPS and HSTS still need to be set up at the reverse proxy before the app is exposed publicly.
- A single shared write token, no per-user accounts.

[Unreleased]: https://github.com/snowseasons-tech/cdot-stations/commits/main
