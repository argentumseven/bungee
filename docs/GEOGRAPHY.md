# Private OpenStreetMap and GeoIP

Bungee serves **local raster OpenStreetMap MBTiles** and looks up addresses in a **local City MMDB** database. GPS remains the primary location. No phone, dashboard or runtime container contacts a map-tile server, geocoder, IP-check service or GeoIP API. There is no external fallback when local data is absent, out of coverage or stale. Dataset acquisition is a separate operator action.

## What is recorded

The gateway reads WireGuard's public `endpoints`, `latest-handshakes` and received-byte counters. It never uses `wg show dump` or exports private/preshared keys for this feature. Only peers with an authenticated handshake are eligible. An unchanged endpoint/counter does not invent a new observation; the first observation after interface creation uses the actual handshake time. Subsequent received traffic is sampled approximately every three seconds. Server collection runs on dashboard refresh and once a minute, so this is sampled history, not a packet capture or complete roaming log. Rapid transitions can be missed.

The Rust server matches each gateway observation to an enrolled, non-revoked, PSK-protected peer. Client JSON, `X-Forwarded-For`, `X-Real-IP` and the inner `10.77.0.x` HTTP connection address are not treated as public-IP evidence. With no gateway observation, it reports no connection address. Gateway snapshots older than 30 seconds are ignored for new collection; stored observations remain available.

IP observations store the address, observation/receipt times and the local GeoIP result/database build date. IPv4 and IPv6 are supported. Private, reserved and unknown addresses remain useful connection observations but have no invented GeoIP coordinates. New dataset versions enrich future observations; historical estimates retain the database result used when collected. GPS points and IP estimates are stored separately.

**IP location is approximate and can be wrong by hundreds of kilometres.** The database centre can identify a carrier, ISP or VPN/proxy exit rather than the phone. It does not establish a home address, identify a person or prove a route. Shared NAT/CGNAT addresses are not unique devices. The displayed database radius is an estimate in **kilometres**, not GPS accuracy in metres, and is not a guarantee. Missing radius is explicitly unknown. No bypass of another VPN or attempt to discover its underlying subscriber IP is made.

## Free local data choices

| Data | Option | Operator responsibility |
| --- | --- | --- |
| Basemap | OpenStreetMap data, rendered into a regional **raster PNG/JPEG MBTiles** archive | [OSM copyright/ODbL](https://www.openstreetmap.org/copyright) and any renderer/style/archive terms apply. Preserve attribution. Choose coverage and zoom levels for the household's travel area. Vector PBF/PMTiles files require rendering/conversion; they cannot be renamed to MBTiles |
| GeoIP | [DB-IP IP to City Lite](https://db-ip.com/db/download/ip-to-city-lite), MMDB format | Free Lite database has attribution/license conditions and lower accuracy than paid editions. Keep required DB-IP attribution; Bungee shows the supplied database type and metadata. Download/unpack on an independently administered host |
| GeoIP | [MaxMind GeoLite2 City](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data/) | Free download requires a MaxMind account/license key and compliance with its terms, including applicable update/deletion requirements. Never place that key in Bungee, a pairing bundle or this repository |

The software does not bundle production tiles or a production GeoIP database, accept provider credentials, register accounts, scrape tiles or schedule dataset downloads. “Free” does not mean anonymous acquisition or unrestricted redistribution. Data providers see the IP/metadata of the machine downloading an archive; they receive no Bungee phone records. Use a separate download machine/offline transfer if that disclosure is unacceptable. The phone never needs a dataset account.

**Do not bulk-download/prefetch the public `tile.openstreetmap.org` service.** It is a limited community resource with its own [usage policy](https://operations.osmfoundation.org/policies/tiles/), not an unrestricted offline archive provider. Use a properly licensed regional archive or render extracts with your own tools. Bungee does not include a tile renderer; raw `.osm.pbf` extracts are not directly usable. High-zoom global raster archives are very large. Raster archives should contain standard `metadata` and `tiles` tables/views, `format=png`/`jpg`/`jpeg`, and optional minzoom/maxzoom (0–22). Tiles use standard TMS row order; the server converts browser XYZ requests.

## Guided installations

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

Clearing a dataset stops its future use; it does not erase existing IP history or old dataset generations. Older dataset directories are retained for coherent recovery and must be included in your host backup/capacity/licensing policy. The five-volume update snapshot contains phone data/keys but **does not include external datasets**; preserve `/opt/bungee/datasets` alongside generation metadata for complete disaster recovery. Do not remove directories referenced by a current/pending generation. Dataset refreshes are explicit local imports; the container security updater does not refresh geodata or reinterpret saved locations.

## Manual Compose

Place the files at `datasets/map.mbtiles` and `datasets/geoip.mmdb`, or set `BUNGEE_GEODATA_DIR` in `.env` to a dedicated local directory. The directory must be readable/traversable by UID 10001 (typically 0755, public dataset files 0644). It is mounted read-only. Do not mix secrets or writable app state into that directory. After replacing files atomically, restart the server to load the new datasets. Manual Compose does not perform the guided import's snapshot/rollback procedure.

Outside Docker, `BUNGEE_GEODATA_DIR` names the directory Rust reads. Missing files disable the corresponding feature; malformed existing files fail startup so deployment health checks catch the problem. Map tiles are session-authenticated, have bounded coordinates/size, are returned as PNG/JPEG only, and have `Cache-Control: no-store`. Attribution metadata is rendered as text, never executed as HTML. The OSM copyright link is only contacted if an administrator explicitly clicks it.

## Dashboard and erasure

Overview shows the last GPS point and a separate **Connection address / Approximate IP location** card. Purple indicates GPS, amber indicates GeoIP. **Show IP estimate** focuses the approximate area without overwriting GPS. Pan/zoom uses only the home server. An unavailable tile displays local-coverage status and never triggers a public-provider request. Without a basemap, markers/coordinates remain available on a neutral background.

History retains the existing GPS recurrence controls and adds **IP observations & GeoIP**: from/to filters, every-N-minute or daily-at-time lookup, pagination, point selection, approximate-area map and CSV containing the original GeoIP snapshot. IP estimates never join the GPS trail. Lines between GPS samples still do not establish a continuous route.

IP history has no automatic expiry. **Erase saved history** deletes GPS, IP and check-in history and sets independent cutoffs to prevent unchanged cached/queued observations from returning. New traffic after erasure may create new records while the phone remains connected. **Forget saved location** is GPS-only. Revoking the device deletes its IP history as well as its GPS/other records. Logical deletion does not scrub old backup/media blocks. Your disk encryption and backup retention policy still matter.

Automated screenshots use an explicitly labeled synthetic raster grid and the MaxMind artificial test MMDB. They are not evidence of real phone travel, a production database's accuracy or complete world street-map coverage.
