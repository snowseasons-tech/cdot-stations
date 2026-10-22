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
- Live road conditions: a panel linking to COtrip.org, the COtrip Planner app (iPhone and Android) and CDOT on X (@ColoradoDOT), and a "Live road conditions nearby" link on every station card and pin popup that opens COtrip centred there with the traffic incidents, closures, construction, weather alerts and weather radar layers on. Links to CDOT's real-time information; the app does not copy or show that data.
- Move a station's pin: if a port has relocated, a team member (web page, write token) can save its new position by tapping the map; the saved position replaces the pin, CDOT's original stays visible with a dashed line, the reason is shown, every save is kept in a history, and one click puts it back. Positions must be inside Colorado and within 100 miles of CDOT's. Saved separately from CDOT's data, so the weekly refresh can't overwrite them, and included in the backups and restore script.
- Push notifications: people using the installed app can follow stations (or all of them) and are notified when a followed station's status or note changes, from the web page, the API or an importer. Followers are kept in `subscriptions.json` on the data volume and included in the backups and the restore script. Off until a VAPID key pair is configured (`scripts/generate-vapid-keys.js`; see the README, "Notifications").
- Installable web app for iPhone and Android, read-only: add it to the Home Screen from `https://stations.snowseasonstech.net` ([docs/install.md](docs/install.md)). Includes a web app manifest and icons, a network-first service worker that never caches the API or sign-in redirects, an install card with iPhone steps, and a clear "Your sign-in has expired" message instead of a broken page. In the installed app the Update status buttons are hidden.
- Public access for the team through a Cloudflare Tunnel with Cloudflare Access (email sign-in) at `https://stations.snowseasonstech.net`, with no router ports opened. Includes a runbook in the README and `scripts/check-public-access.sh`, which proves an unauthenticated visitor is sent to the sign-in instead of being served the app.
- Alerts for backups through GitHub issues: one when a backup fails, and one when no backup has arrived for over 30 hours (server off, cron stopped).

### Security
- The push follow endpoints only accept real push-service addresses (so the server can't be aimed at other hosts), JSON requests that aren't marked cross-site, and are rate limited and capped.
- The project now has one npm dependency, `web-push`, pinned to an exact version with a lockfile and installed without install scripts; Dependabot opens weekly update PRs for it, the GitHub Actions and the Node base image.
- Write endpoints require a bearer token (`STATUS_TOKEN`). The token is compared in constant time, and a client is locked out for a minute after 10 failed attempts. The server refuses to listen on a non-local address without a token.
- Content-Security-Policy and other security headers on every response; API responses are not cacheable.
- Leaflet is loaded from a CDN with a pinned version and Subresource Integrity hashes.
- Manual status updates accept only a status and a note; the source and timestamp are always set by the server.
- The map's hover tooltip no longer renders place names as HTML (a name containing markup used to create real elements); a test now prevents strings being passed to Leaflet popups and tooltips.

### Changed
- The token field on the status editor is now labelled "Write token", to avoid confusion with Cloudflare Access.
- The nginx site now passes the visitor's real address to the app when requests arrive through a Cloudflare Tunnel (ignored for LAN requests, so it can't be spoofed). Applies when `scripts/install-nginx-site.sh` is re-run.
- The nginx site compresses JSON, JavaScript and CSS responses (the map data goes from 106 KB to about 16 KB). Applies when `scripts/install-nginx-site.sh` is re-run on the server.

### Fixed
- Static files (the page, scripts, styles, icons) are now sent with an ETag, `Cache-Control: no-cache` and `CDN-Cache-Control: no-store`. Before, Cloudflare and phones kept serving old copies for hours after a deploy, so new features didn't appear (the Follow buttons never showed on a phone running an old `app.js`).
- Simultaneous status updates no longer fail: disk writes are queued, so overlapping updates can't race on the temporary file (previously all but one of a burst of concurrent updates returned an error, though the data was still saved).

### Known limitations
- Status is not live; it is only as current as the last manual update or import.
- Served over plain HTTP on the home network. HTTPS and HSTS still need to be set up at the reverse proxy before the app is exposed publicly.
- A single shared write token, no per-user accounts.

[Unreleased]: https://github.com/snowseasons-tech/cdot-stations/commits/main
