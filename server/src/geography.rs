//! Offline geographic data. No HTTP client, provider lookup or reverse DNS.
use crate::{App, security::*};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
};
use maxminddb::{Reader, geoip2};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{env, fs, net::IpAddr, path::PathBuf, sync::Mutex};

pub async fn vector_archive(
    State(app): State<App>,
    request: axum::extract::Request,
) -> ApiResult<axum::response::Response> {
    require_admin(&app, request.headers())?;
    let path = app
        .geography
        .pmtiles
        .as_ref()
        .ok_or(Error(StatusCode::NOT_FOUND, "No street map installed"))?;
    serve_vector(path, request).await
}

pub async fn serve_vector(
    path: &std::path::Path,
    request: axum::extract::Request,
) -> ApiResult<axum::response::Response> {
    // PMTiles uses bounded byte ranges, never a full-world response in memory.
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes="))
        .and_then(|v| v.split_once('-'))
        .and_then(|(a, b)| Some((a.parse::<u64>().ok()?, b.parse::<u64>().ok()?)));
    if !range.is_some_and(|(a, b)| b >= a && b - a < 16 * 1024 * 1024) {
        return Err(bad("Use a single byte range up to 16 MiB"));
    }
    tower_http::services::ServeFile::new(path)
        .try_call(request)
        .await
        .map(IntoResponse::into_response)
        .map_err(|_| Error(StatusCode::INTERNAL_SERVER_ERROR, "Map archive unavailable"))
}

pub struct Geography {
    tiles: Option<Mutex<Connection>>,
    geoip: Option<Reader<Vec<u8>>>,
    geoip_v6: Option<Reader<Vec<u8>>>,
    pmtiles: Option<PathBuf>,
    pub status: Value,
}
impl Geography {
    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
        let root = PathBuf::from(env::var("BUNGEE_GEODATA_DIR").unwrap_or("/datasets".into()));
        Self::open(root)
    }
    fn open(root: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        let mut status = json!({"maps":null,"geoip":null,"vector":null});
        let pmtiles = if root.join("map.pmtiles").try_exists()? {
            use std::io::Read;
            let path = root.join("map.pmtiles");
            let mut file = fs::File::open(&path)?;
            let size = file.metadata()?.len();
            let mut header = [0u8; 127];
            file.read_exact(&mut header)?;
            if &header[..8] != b"PMTiles\x03"
                || header[99] != 1
                || ![1, 2].contains(&header[97])
                || ![1, 2].contains(&header[98])
                || header[100] > header[101]
                || header[101] > 22
                || size > 25_000_000_000
            {
                return Err("Expected a vector MVT PMTiles v3 archive within 25 GB".into());
            }
            for at in [8, 24, 40, 56] {
                let offset = u64::from_le_bytes(header[at..at + 8].try_into()?);
                let length = u64::from_le_bytes(header[at + 8..at + 16].try_into()?);
                if offset.checked_add(length).is_none_or(|end| end > size) {
                    return Err("PMTiles section exceeds archive".into());
                }
            }
            status["vector"] = json!({"min_zoom":header[100],"max_zoom":header[101],"format":"pmtiles","name":"Local street map","bytes":size});
            Some(path)
        } else {
            None
        };
        let tiles = if root.join("map.mbtiles").try_exists()? {
            let db = Connection::open_with_flags(
                root.join("map.mbtiles"),
                OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            db.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;")?;
            let metadata = |key: &str| -> rusqlite::Result<Option<String>> {
                db.query_row(
                    "SELECT value FROM metadata WHERE name=? AND length(value)<=4096 LIMIT 1",
                    [key],
                    |r| r.get(0),
                )
                .optional()
            };
            let format = metadata("format")?.ok_or("Raster MBTiles needs format=png or jpg")?;
            if !["png", "jpg", "jpeg"].contains(&format.as_str()) {
                return Err(
                    "Only raster PNG/JPEG MBTiles is supported; vector PBF needs rendering first"
                        .into(),
                );
            }
            let min = metadata("minzoom")?
                .map(|v| v.parse::<u8>())
                .transpose()?
                .unwrap_or(0);
            let max = metadata("maxzoom")?
                .map(|v| v.parse::<u8>())
                .transpose()?
                .unwrap_or(18);
            if min > max || max > 22 {
                return Err("Map zoom must be an ordered range within 0..22".into());
            }
            // Require a usable representative raster, not just an empty/renamed vector archive.
            let sample: Vec<u8> = db.query_row(
                "SELECT tile_data FROM tiles WHERE length(tile_data)<=2097152 LIMIT 1",
                [],
                |r| r.get(0),
            )?;
            if !sample.starts_with(b"\x89PNG\r\n\x1a\n") && !sample.starts_with(b"\xff\xd8\xff") {
                return Err("Map archive has no supported raster sample".into());
            }
            db.prepare(
                "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
            )?;
            status["maps"] = json!({"min_zoom":min,"max_zoom":max,"name":metadata("name")?,"attribution":"© OpenStreetMap contributors","dataset_attribution":metadata("attribution")?,"format":format,"overview":metadata("bungee_map_kind")?.as_deref()==Some("overview")});
            Some(Mutex::new(db))
        } else {
            None
        };
        let geoip = if root.join("geoip.mmdb").try_exists()? {
            if fs::metadata(root.join("geoip.mmdb"))?.len() > 256 * 1024 * 1024 {
                return Err("GeoIP dataset exceeds 256 MiB limit".into());
            }
            let reader = Reader::open_readfile(root.join("geoip.mmdb"))?;
            status["geoip"] = json!({"database_type":reader.metadata().database_type,"build_epoch":reader.metadata().build_epoch});
            Some(reader)
        } else {
            None
        };
        let geoip_v6 = if root.join("geoip-v6.mmdb").try_exists()? {
            if fs::metadata(root.join("geoip-v6.mmdb"))?.len() > 256 * 1024 * 1024 {
                return Err("GeoIP IPv6 dataset exceeds 256 MiB".into());
            }
            Some(Reader::open_readfile(root.join("geoip-v6.mmdb"))?)
        } else {
            None
        };
        Ok(Self {
            tiles,
            geoip,
            geoip_v6,
            pmtiles,
            status,
        })
    }
    fn locate(&self, ip: IpAddr) -> Option<Value> {
        if !public_ip(ip) {
            return None;
        }
        let reader = if ip.is_ipv6() {
            self.geoip_v6.as_ref().or(self.geoip.as_ref())
        } else {
            self.geoip.as_ref()
        }?;
        // The bundled DB-IP Lite mirror uses flat field names, unlike MaxMind City.
        if let Some(record) = reader.lookup(ip).ok()?.decode::<Value>().ok()?
            && record.get("country_code").is_some()
        {
            let number = |key| {
                record
                    .get(key)
                    .and_then(Value::as_f64)
                    .filter(|v| v.is_finite())
            };
            let latitude = number("latitude").filter(|v| (-90.0..=90.0).contains(v));
            let longitude = number("longitude").filter(|v| (-180.0..=180.0).contains(v));
            return Some(
                json!({"latitude":latitude,"longitude":longitude,"accuracy_radius_km":null,"city":record.get("city"),"region":record.get("state1"),"country":record.get("country_code"),"database_type":format!("DBIP Lite · {}",reader.metadata().database_type),"database_build_epoch":reader.metadata().build_epoch}),
            );
        }
        let city = reader.lookup(ip).ok()?.decode::<geoip2::City>().ok()??;
        let lat = city
            .location
            .latitude
            .filter(|v| v.is_finite() && (-90.0..=90.0).contains(v));
        let lon = city
            .location
            .longitude
            .filter(|v| v.is_finite() && (-180.0..=180.0).contains(v));
        Some(
            json!({"latitude":lat,"longitude":lon,"accuracy_radius_km":city.location.accuracy_radius,
            "city":city.city.names.english,"country":city.country.iso_code,
            "region":city.subdivisions.last().and_then(|s|s.names.english),
            "database_type":reader.metadata().database_type,"database_build_epoch":reader.metadata().build_epoch}),
        )
    }
}
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let [a, b, c, _] = v.octets();
            !(v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_broadcast()
                || v.is_documentation()
                || a == 0
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 198 && (b == 18 || b == 19)))
        }
        IpAddr::V6(v) => {
            let s = v.segments();
            // Only global unicast, excluding documentation, benchmarking, mapped and transition ranges.
            (s[0] & 0xe000 == 0x2000)
                && !(s[0] == 0x2001 && (s[1] <= 0x1ff || s[1] == 0xdb8))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}
pub async fn status(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let mut status = app.geography.status.clone();
    // A broken optional download catalogue must not hide the bundled raster map.
    match crate::maps::installed() {
        Ok(regions) => status["regions"] = regions,
        Err(error) => {
            status["regions"] = json!([]);
            status["regional_error"] = json!(error.1);
        }
    }
    Ok(Json(status))
}
pub async fn tile(
    State(app): State<App>,
    headers: HeaderMap,
    Path((z, x, y)): Path<(u8, u32, u32)>,
) -> ApiResult<impl IntoResponse> {
    require_admin(&app, &headers)?;
    if z > 22 || x >= 1u32 << z || y >= 1u32 << z {
        return Err(bad("Tile coordinates out of range"));
    }
    let bytes = tokio::task::spawn_blocking(move || -> ApiResult<Vec<u8>> {
        let db = app.geography.tiles.as_ref().ok_or(Error(StatusCode::NOT_FOUND,"No local map dataset"))?.lock().unwrap();
        // MBTiles rows are TMS (south origin), the browser requests XYZ (north origin).
        db.query_row("SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=? AND length(tile_data)<=2097152 LIMIT 1", params![z,x,(1u32<<z)-1-y], |r| r.get(0)).optional()?.ok_or(Error(StatusCode::NOT_FOUND,"Tile outside local coverage"))
    }).await.map_err(|_| Error(StatusCode::INTERNAL_SERVER_ERROR,"Map operation failed"))??;
    let content_type = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else {
        return Err(Error(StatusCode::NOT_FOUND, "Invalid raster tile"));
    };
    Ok(([(header::CONTENT_TYPE, content_type)], bytes))
}
#[derive(Deserialize)]
struct Endpoints {
    sampled_at: i64,
    peers: Vec<Endpoint>,
}
#[derive(Deserialize)]
struct Endpoint {
    public_key: String,
    ip: IpAddr,
    observed_at: i64,
}
/// Read only gateway-observed, authenticated WireGuard peers. Never trust HTTP forwarding headers.
pub fn collect(app: &App) -> ApiResult<()> {
    let path = app.state_dir.join("wireguard/endpoints.json");
    match fs::metadata(&path) {
        Ok(m) if m.len() > 1024 * 1024 => return Err(bad("Endpoint snapshot exceeds limit")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
        _ => {}
    }
    let data = match fs::read(path) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    if data.len() > 1024 * 1024 {
        return Err(bad("Endpoint snapshot exceeds limit"));
    }
    let snapshot: Endpoints =
        serde_json::from_slice(&data).map_err(|_| bad("Invalid endpoint snapshot"))?;
    let current = now();
    if snapshot.sampled_at > current + 5
        || snapshot.sampled_at < current - 30
        || snapshot.peers.len() > 1000
    {
        return Ok(());
    }
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    for peer in snapshot.peers {
        if peer.observed_at <= 0
            || peer.observed_at > snapshot.sampled_at
            || peer.public_key.len() != 44
        {
            continue;
        }
        let id: Option<String> = tx.query_row("SELECT id FROM devices WHERE wg_key=? AND revoked=0 AND wg_psk IS NOT NULL AND public_key IS NOT NULL AND network_floor<?",params![peer.public_key,peer.observed_at],|r|r.get(0)).optional()?;
        if let Some(id) = id {
            let geo = app.geography.locate(peer.ip).map(|v| v.to_string());
            tx.execute("INSERT OR IGNORE INTO network_history(device_id,observed_at,received_at,ip,geoip) VALUES(?,?,?,?,?)",params![id,peer.observed_at,current,peer.ip.to_string(),geo])?;
        }
    }
    tx.commit()?;
    Ok(())
}
pub fn latest(db: &Connection, id: &str) -> rusqlite::Result<Option<Value>> {
    db.query_row("SELECT observed_at,received_at,ip,geoip FROM network_history WHERE device_id=? ORDER BY observed_at DESC LIMIT 1", [id], record).optional()
}
pub fn record(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"observed_at":r.get::<_,i64>(0)?,"received_at":r.get::<_,i64>(1)?,"ip":r.get::<_,String>(2)?,"source":"wireguard_endpoint","geoip":r.get::<_,Option<String>>(3)?.and_then(|s|serde_json::from_str::<Value>(&s).ok())}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundled_overview_is_a_valid_global_offline_basemap() {
        let root = std::env::temp_dir().join(format!("bungee-world-map-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::copy(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../basemap/world.mbtiles"),
            root.join("map.mbtiles"),
        )
        .unwrap();
        {
            let geography = Geography::open(root.clone()).unwrap();
            assert_eq!(geography.status["maps"]["overview"], true);
            assert_eq!(geography.status["maps"]["max_zoom"], 6);
            let db = geography.tiles.as_ref().unwrap().lock().unwrap();
            let count: i64 = db
                .query_row("SELECT COUNT(*) FROM tiles", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 5461);
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn no_geoip_for_local_or_reserved_addresses() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "100.64.1.1",
            "169.254.1.1",
            "192.0.2.3",
            "198.18.0.1",
            "255.255.255.255",
            "::1",
            "fd00::1",
            "fe80::1",
            "2001:db8::1",
            "::ffff:8.8.8.8",
            "2002::1",
            "3fff::1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(public_ip(ip.parse().unwrap()));
        }
    }
}
