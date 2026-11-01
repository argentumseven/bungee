Place operator-supplied `map.mbtiles` (raster PNG/JPEG OpenStreetMap data) and/or
`geoip.mmdb` (City MMDB) here for manual Compose. Provider data is never downloaded by runtime containers; credentials are not bundled. See [private map setup](../docs/GEOGRAPHY.md).

Guided installations now seed the bundled Natural Earth overview and DB-IP Lite City snapshot, then acquire US street detail when space/connectivity permit. Manual Compose: copy `basemap/world.mbtiles` here as `map.mbtiles`, or place MVT PMTiles v3 at `map.pmtiles`. See [current setup and licensing](../docs/GEOGRAPHY.md).
