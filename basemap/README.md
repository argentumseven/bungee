# Bundled local world overview

`world.mbtiles` is a world overview at zooms 0–6, with land, country boundaries
and major towns. It is installed automatically by the guided installer. It is
**not street-level coverage**. Use `bungee-host.py maps-us` for US streets, or import a regional raster MBTiles/vector PMTiles archive for streets and higher zooms; see [map setup](../docs/GEOGRAPHY.md).

Source: Natural Earth **5.1.2**, `ne_50m_admin_0_countries.geojson` and
`ne_50m_populated_places.geojson` from the
[Natural Earth repository](https://github.com/nvkelso/natural-earth-vector/tree/v5.1.2/geojson).
Natural Earth data is public domain; see its
[terms of use](https://www.naturalearthdata.com/about/terms-of-use/).
Labels use the DejaVu Sans font installed on the maintainer's rendering machine.
The [DejaVu font license](https://dejavu-fonts.github.io/License.html) permits
redistribution of rendered output. The font itself is not redistributed here.

Rebuild using `scripts/build-basemap.py` and Pillow with DejaVu Sans available.
Place the two source files under the names `countries.geojson` and
`places.geojson` in the directory passed to `--source`. The checksum next to the
archive identifies this exact rendered dataset. Acquisition/rendering is a
maintainer action: installed phones, browsers and runtime containers fetch no
provider tiles or map data.

The bundled DB-IP IP to City Lite snapshot contains IPv4 and IPv6 City databases
from the `sapics/ip-location-db` conversion, acquired 2026-11-01; the embedded
source database build is October 2026. `geoip.json` records the source URLs and
compressed/uncompressed SHA-256 checksums. The mirror uses flat City records;
Bungee also continues to support MaxMind-format City MMDB imports.

IP Geolocation by [DB-IP](https://db-ip.com), licensed under
[Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
You may share and adapt the data with attribution. Lite data is approximate and
can be stale, especially on mobile networks and VPN exits. No subscriber location
or home address is established by an IP estimate. Dataset replacement is explicit.

`us.geojson` is the United States boundary from the same public-domain Natural
Earth dataset, used only to select intersecting tiles from a Protomaps archive.
