# Private OpenStreetMap and GeoIP

Bungee serves **local raster MBTiles and vector MVT PMTiles v3** and looks up addresses in a **local City MMDB** database. GPS remains the primary location. No phone, dashboard or runtime container contacts a map-tile server, geocoder, IP-check service or GeoIP API. There is no external fallback when local data is absent, out of coverage or stale. The guided installer seeds bundled overview/GeoIP data and offers regional street-map downloads; the same downloader is available in Settings → Maps & storage. Additional refreshes/imports are explicit operator actions.

## What is recorded

The gateway reads WireGuard's public `endpoints`, `latest-handshakes` and received-byte counters. It never uses `wg show dump` or exports private/preshared keys for this feature. Only peers with an authenticated handshake are eligible. An unchanged endpoint/counter does not invent a new observation; the first observation after interface creation uses the actual handshake time. Subsequent received traffic is sampled approximately every three seconds. Server collection runs on dashboard refresh and once a minute, so this is sampled history, not a packet capture or complete roaming log. Rapid transitions can be missed.

The Rust server matches each gateway observation to an enrolled, non-revoked, PSK-protected peer. Client JSON, `X-Forwarded-For`, `X-Real-IP` and the inner `10.77.0.x` HTTP connection address are not treated as public-IP evidence. With no gateway observation, it reports no connection address. Gateway snapshots older than 30 seconds are ignored for new collection; stored observations remain available.

IP observations store the address, observation/receipt times and the local GeoIP result/database build date. IPv4 and IPv6 are supported. Private, reserved and unknown addresses remain useful connection observations but have no invented GeoIP coordinates. New dataset versions enrich future observations; historical estimates retain the database result used when collected. GPS points and IP estimates are stored separately.

**IP location is approximate and can be wrong by hundreds of kilometres.** The database centre can identify a carrier, ISP or VPN/proxy exit rather than the phone. It does not establish a home address, identify a person or prove a route. Shared NAT/CGNAT addresses are not unique devices. The displayed database radius is an estimate in **kilometres**, not GPS accuracy in metres, and is not a guarantee. Missing radius is explicitly unknown. No bypass of another VPN or attempt to discover its underlying subscriber IP is made.

## Free local data choices

| Data | Option | Operator responsibility |
| --- | --- | --- |
| Basemap | OpenStreetMap data, rendered into a regional **raster PNG/JPEG MBTiles** archive | [OSM copyright/ODbL](https://www.openstreetmap.org/copyright) and any renderer/style/archive terms apply. Preserve attribution. Choose coverage and zoom levels for the household's travel area. Vector MVT PMTiles v3 is rendered locally in the browser with bundled assets; files must retain the .pmtiles suffix |
| GeoIP | [DB-IP IP to City Lite](https://db-ip.com/db/download/ip-to-city-lite), MMDB format | Free Lite database has attribution/license conditions and lower accuracy than paid editions. Keep required DB-IP attribution; Bungee shows the supplied database type and metadata. Download/unpack on an independently administered host |
| GeoIP | [MaxMind GeoLite2 City](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data/) | Free download requires a MaxMind account/license key and compliance with its terms, including applicable update/deletion requirements. Never place that key in Bungee, a pairing bundle or this repository |

The repository bundles a Natural Earth world overview, regional boundaries and a checksummed DB-IP Lite City snapshot for IPv4/IPv6. The installer and web manager share a catalogue of 248 regions: eight US regions including Alaska/Hawaii, plus country regions grouped by continent. The initial size estimates use a documented population/area model; they are rough guidance, not measured archive sizes. A current PMTiles dry-run plan is required before downloading. Managed archives use zoom 0–15 and are limited to 24 installed regions and 25 GB total, including any imported legacy street archive. A pinned checksum-verified extraction tool queries only regional byte ranges rather than downloading the planet. Provider requests identify `Bungee map installer` and preserve TLS verification.

The downloader does not register accounts, take provider credentials or scrape public raster tiles. Explicit installation requests cause the **host worker** to contact GitHub and the Protomaps catalogue/build hosts. Providers see the downloading server's IP and requested geographic region; they receive no phone coordinates or records. Runtime phones, dashboards and app containers use only the home server.

**Do not bulk-download/prefetch the public `tile.openstreetmap.org` service.** It is a limited community resource with its own [usage policy](https://operations.osmfoundation.org/policies/tiles/), not an unrestricted offline archive provider. Use a properly licensed regional archive or render extracts with your own tools. Bungee renders PMTiles vectors in the browser; raw `.osm.pbf` extracts are not directly usable. A full Protomaps planet vector archive is about 120 GB (zoom 0–15); detailed worldwide raster maps are larger. A US extract is substantially smaller, but exact size changes with the build and zoom. The importer estimates before downloading and never downloads a full planet to obtain the US. Raster archives should contain standard `metadata` and `tiles` tables/views, `format=png`/`jpg`/`jpeg`, and optional minzoom/maxzoom (0–22). Tiles use standard TMS row order; the server converts browser XYZ requests.

## Guided installations

After updating the server/helper to 1.1.8, choose **Settings → Maps & storage**, select regions, calculate the combined extraction plan, review safe free capacity, then download. This installs the worker and required mounts through the normal host rebuild; no separate data-initialization command is required. The guided installer offers the same regional checklist. Existing custom datasets are preserved.

```sh
python3 /opt/bungee/bungee-host.py maps
python3 /opt/bungee/bungee-host.py maps --regions us-pacific,us-mountain --plan
python3 /opt/bungee/bungee-host.py maps --regions us-pacific,us-mountain
```

The `maps` command opens the checklist; `--regions` supplies IDs directly. Map `--plan` contacts providers to calculate sizes but installs no archives. `maps-us` selects all eight US regions and also accepts `--plan`. The old `geodata` command can still seed missing overview/GeoIP, and local `datasets` imports remain supported.

Map capacity uses unprivileged-available filesystem blocks (`f_bavail`), so ext4 reserved blocks are not offered as map capacity. Existing swap files, retained datasets and rollback data already reduce available space and are not subtracted twice. Additional reserves protect a new full private-volume cold snapshot (logical bytes plus archive headroom), history/system data, temporary work and swap growth; the backing filesystem must also have tool/swap headroom. Capacity and the total map limit are checked again on installation and while downloading; shrinking free space cancels an unsafe download. Storage is never resized automatically.

Managed downloads stage on the same encrypted filesystem, verify, then publish the archive/manifest atomically without an import copy or server restart. Interrupted/failed/canceled downloads preserve installed maps; abandoned staging is cleaned under the map-job lock. The web UI shows installed regions, actual archive sizes, job progress and removal controls. A root-owned host worker consumes only small, validated action/region/plan-ID requests: no URL, shell command or filesystem path can be supplied by the web client. Container mounts keep archives/status read-only and expose only the request directory for writes. Plan IDs must match the reviewed selection and expire after one hour.

A world overview/GeoIP message does not confirm street maps. Provider errors identify the failed stage/endpoint. The catalogue was observed returning HTTP 403 / Cloudflare error 1010 for Python's default user agent and HTTP 200 for `Bungee map installer` on the same Debian host; both catalogue and tool requests use that explicit identifier. The runtime test environment cannot reach the provider catalogue/build hosts, so full live regional extraction still requires a deployment-host check. The actual pinned tool's regional extraction/verification has been tested with a synthetic archive.

The bundled overview is 7.7 MB at zoom 0–6, derived from Natural Earth 5.1.2 public-domain countries/places. It supplies context, not street detail. The bundled DB-IP files are about 61 MB compressed / 131 MB expanded; provenance and hashes are in `basemap/geoip.json`, with CC BY 4.0 attribution in `basemap/README.md`. The build date remains visible on estimates. US basemap extraction uses the Natural Earth US boundary including Alaska and Hawaii. Runtime PMTiles byte ranges require an administrator session and are limited to 16 MiB per request.

After the guided host install, import files already obtained locally:

```sh
sudo python3 /opt/bungee/bungee-host.py datasets \
  --maps /srv/offline-data/region.mbtiles \
  --geoip /srv/offline-data/City.mmdb
```

Either argument can be supplied alone; the other current dataset is copied forward. Inputs must be regular files, not symlinks or URLs. MMDB is limited to 256 MiB. The importer validates datasets in a disposable, network-disabled, unprivileged container using the installed server image **before downtime**. Invalid formats or unreadable files are rejected without replacing the running configuration.

The importer makes a new, read-only dataset directory and applies it through the same maintenance/snapshot/health/recovery transaction as configuration changes. Each generation pins its dataset directory. An unsuccessful trial rolls back to the previous dataset/configuration. Neither the phone's settings nor its permissions change.

```sh
sudo python3 /opt/bungee/bungee-host.py datasets --clear-maps
sudo python3 /opt/bungee/bungee-host.py datasets --clear-geoip
```

Clearing a dataset stops its future use; it does not erase existing IP history or old dataset generations. Older dataset directories are retained for coherent recovery and must be included in your host backup/capacity/licensing policy. The encrypted cold update snapshot contains phone data/keys but **does not include external datasets**; preserve `/opt/bungee/datasets` alongside generation metadata for complete disaster recovery. Do not remove directories referenced by a current/pending generation. Dataset refreshes are explicit local imports; the container security updater does not refresh geodata or reinterpret saved locations.

## Manual Compose

Copy `basemap/world.mbtiles` to `datasets/map.mbtiles` for an overview, or place a vector archive at `datasets/map.pmtiles`; City data goes at `datasets/geoip.mmdb` (and optional `geoip-v6.mmdb` for a separate IPv6 database), or set `BUNGEE_GEODATA_DIR` in `.env` to a dedicated local directory. The directory must be readable/traversable by UID 10001 (typically 0755, public dataset files 0644). It is mounted read-only. Do not mix secrets or writable app state into that directory. After replacing files atomically, restart the server to load the new datasets. Manual Compose does not perform the guided import's snapshot/rollback procedure.

Outside Docker, `BUNGEE_GEODATA_DIR` names the directory Rust reads. Missing files disable the corresponding feature; malformed existing files fail startup so deployment health checks catch the problem. Raster tiles and vector byte ranges are session-authenticated, have bounded coordinates/size, and have `Cache-Control: no-store`. Attribution metadata is rendered as text, never executed as HTML. The OSM copyright link is only contacted if an administrator explicitly clicks it.

## Dashboard and erasure

Overview shows the last GPS point and a separate **Connection address / Approximate IP location** card. Teal indicates GPS, amber indicates GeoIP. **Show IP estimate** focuses the approximate area without overwriting GPS. Current estimate and GPS history use the same local map renderer. The redundant unlabelled coordinate-only chart was removed. Selected/latest GPS points focus at street scale when coverage exists; Show all loaded points fits the full trail. Nearby named road geometry can provide an approximate street label and distance; it is not a verified building/postal address or a public reverse-geocoder lookup. Pan/zoom uses only the home server. An unavailable tile displays local-coverage status and never triggers a public-provider request. Without a basemap, markers/coordinates remain available on a neutral background.

Tracking → GPS history retains the existing GPS recurrence controls and adds **IP observations & GeoIP**: from/to filters, every-N-minute or daily-at-time lookup, pagination, point selection, approximate-area map and CSV containing the original GeoIP snapshot. IP estimates never join the GPS trail. Lines between GPS samples still do not establish a continuous route.

IP history has no automatic expiry. **Erase saved history** deletes GPS, IP and check-in history and sets independent cutoffs to prevent unchanged cached/queued observations from returning. New traffic after erasure may create new records while the phone remains connected. **Forget saved location** is GPS-only. Revoking the device deletes its IP history as well as its GPS/other records. Logical deletion does not scrub old backup/media blocks. Your disk encryption and backup retention policy still matter.

Automated screenshots use an explicitly labeled synthetic raster grid and the MaxMind artificial test MMDB. They are not evidence of real phone travel, a production database's accuracy or complete world street-map coverage.
