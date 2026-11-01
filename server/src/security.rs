use crate::App;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    extract::{Request, State},
    http::{HeaderMap, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use p256::{
    ecdsa::{Signature, VerifyingKey, signature::Verifier},
    pkcs8::DecodePublicKey,
};
use rand::{RngCore, rngs::OsRng};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{self, Write},
    net::IpAddr,
    path::Path,
};

pub type ApiResult<T> = Result<T, Error>;
#[derive(Debug)]
pub struct Error(pub StatusCode, pub &'static str);
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, axum::Json(serde_json::json!({"error":self.1}))).into_response()
    }
}
impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        tracing::error!(error=%e, "database operation failed");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Storage operation failed",
        )
    }
}
impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        tracing::error!(error=%e, "state operation failed");
        Self(StatusCode::INTERNAL_SERVER_ERROR, "State operation failed")
    }
}
pub fn bad(message: &'static str) -> Error {
    Error(StatusCode::BAD_REQUEST, message)
}
pub fn denied() -> Error {
    Error(StatusCode::UNAUTHORIZED, "Authentication required")
}
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}
pub fn admin_bind(value: &str) -> Result<std::net::SocketAddr, &'static str> {
    let bind: std::net::SocketAddr = value
        .parse()
        .map_err(|_| "BUNGEE_ADMIN_BIND must be a numeric socket address")?;
    if bind.port() == 0 || bind.ip().is_multicast() || phone_address(bind.ip()) {
        return Err(
            "BUNGEE_ADMIN_BIND requires a nonzero management port outside the phone overlay",
        );
    }
    Ok(bind)
}
pub fn device_bind(value: &str) -> Result<std::net::SocketAddr, &'static str> {
    let bind: std::net::SocketAddr = value
        .parse()
        .map_err(|_| "BUNGEE_DEVICE_BIND must be a numeric loopback or 10.77.0.1 address")?;
    if bind.port() == 0
        || !(bind.ip().is_loopback()
            || (bind.ip() == IpAddr::from([10, 77, 0, 1]) && bind.port() == 8081))
    {
        return Err(
            "BUNGEE_DEVICE_BIND must use a nonzero loopback port or the fixed WireGuard API 10.77.0.1:8081; wildcard/public/LAN binds are forbidden",
        );
    }
    Ok(bind)
}
pub fn token() -> String {
    let mut b = [0u8; 32];
    OsRng.fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}
pub fn hash(value: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(value))
}
pub fn password_hash(password: &str) -> Result<String, argon2::password_hash::Error> {
    Argon2::default()
        .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
        .map(|v| v.to_string())
}
pub fn password_matches(value: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|h| {
        Argon2::default()
            .verify_password(value.as_bytes(), &h)
            .is_ok()
    })
}

#[derive(Clone, Copy, Hash, Eq, PartialEq)]
pub enum RateClass {
    AdminSource,
    AdminAggregate,
    DeviceSource,
    UpdateSource,
    UpdateIdentity,
    DeviceIdentity,
    Enrollment,
    Dns,
}

#[derive(Default)]
pub struct RateLimits(HashMap<RateClass, HashMap<String, (i64, u16)>>);
impl RateLimits {
    fn check(&mut self, class: RateClass, key: String, limit: u16, at: i64) -> ApiResult<()> {
        let bucket = self.0.entry(class).or_default();
        bucket.retain(|_, (start, _)| at.saturating_sub(*start) < 60);
        // Capacity applies only to NEW identities in this class. Existing peers and
        // the separate administrator budgets remain usable when a class is full.
        if !bucket.contains_key(&key) && bucket.len() >= 4096 {
            return Err(Error(StatusCode::TOO_MANY_REQUESTS, "Please retry later"));
        }
        let entry = bucket.entry(key).or_insert((at, 0));
        entry.1 = entry.1.saturating_add(1);
        if entry.1 > limit {
            Err(Error(StatusCode::TOO_MANY_REQUESTS, "Please retry later"))
        } else {
            Ok(())
        }
    }
}
pub fn rate_limit(app: &App, class: RateClass, key: String, limit: u16) -> ApiResult<()> {
    app.limiter.lock().unwrap().check(class, key, limit, now())
}

pub async fn device_source_guard(State(app): State<App>, req: Request, next: Next) -> Response {
    let Some(peer) = req
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
    else {
        return denied().into_response();
    };
    // WireGuard validates each peer's source address. Never accept a caller's
    // device ID or a forwarding header as pre-authentication identity.
    let update = req.uri().path() == "/v1/app-update/chunk";
    if let Err(e) = rate_limit(
        &app,
        if update {
            RateClass::UpdateSource
        } else {
            RateClass::DeviceSource
        },
        peer.0.ip().to_string(),
        if update { 1200 } else { 600 },
    ) {
        return e.into_response();
    }
    next.run(req).await
}

pub fn admin_networks(https: bool) -> Result<Vec<ipnet::IpNet>, Box<dyn std::error::Error>> {
    let value = std::env::var("BUNGEE_ADMIN_SUBNETS").unwrap_or_default();
    parse_admin_networks(&value, https)
}

fn parse_admin_networks(
    value: &str,
    https: bool,
) -> Result<Vec<ipnet::IpNet>, Box<dyn std::error::Error>> {
    if value.trim().is_empty() && !https {
        return Ok(vec!["127.0.0.0/8".parse()?, "::1/128".parse()?]);
    }
    let mut nets = Vec::new();
    for entry in value
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|s| !s.is_empty())
    {
        let net: ipnet::IpNet = if entry.contains('/') {
            entry.parse()?
        } else {
            ipnet::IpNet::from(entry.parse::<IpAddr>()?)
        };
        let min = if net.addr().is_ipv4() { 8 } else { 16 };
        if net.prefix_len() < min
            || net.network().is_unspecified()
            || net.network().is_multicast()
            || matches!(net, ipnet::IpNet::V6(n) if n.addr().to_ipv4_mapped().is_some())
        {
            return Err("Administrator prefixes must be explicit unicast networks (/8 IPv4 or /16 IPv6 or narrower)".into());
        }
        if phone_address(net.network()) || net.contains(&IpAddr::from([10, 77, 0, 1])) {
            return Err(
                "Administrator prefixes must not overlap the phone C2 subnet 10.77.0.0/24".into(),
            );
        }
        nets.push(net);
    }
    if nets.is_empty() || nets.len() > 32 {
        return Err("Configure 1–32 BUNGEE_ADMIN_SUBNETS".into());
    }
    Ok(nets)
}

fn phone_address(ip: IpAddr) -> bool {
    let ip = match ip {
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(ip)),
        other => other,
    };
    matches!(ip, IpAddr::V4(ip) if ip.octets()[..3] == [10, 77, 0])
}

fn administrator_source(ip: IpAddr, networks: &[ipnet::IpNet]) -> bool {
    !phone_address(ip) && networks.iter().any(|net| net.contains(&ip))
}

pub fn require_admin(app: &App, headers: &HeaderMap) -> ApiResult<()> {
    require_admin_db(&app.db.lock().unwrap(), headers)
}

pub fn require_admin_db(db: &rusqlite::Connection, headers: &HeaderMap) -> ApiResult<()> {
    let cookie = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let value = cookie
        .split(';')
        .map(str::trim)
        .find_map(|c| c.strip_prefix("bungee_session="))
        .ok_or_else(denied)?;
    if value.len() > 128 {
        return Err(denied());
    }
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE hash=? AND expires>?)",
        params![hash(value), now()],
        |r| r.get(0),
    )?;
    if exists { Ok(()) } else { Err(denied()) }
}

pub async fn browser_guard(State(app): State<App>, req: Request, next: Next) -> Response {
    let Some(peer) = req
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
    else {
        return denied().into_response();
    };
    let ip = match peer.0.ip() {
        IpAddr::V6(v) => v.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v)),
        ip => ip,
    };
    if !(administrator_source(ip, &app.admin_networks)
        || (ip.is_loopback() && req.uri().path() == "/healthz"))
    {
        return Error(StatusCode::FORBIDDEN, "Administrator source rejected").into_response();
    }
    // Cookie-authenticated mutations require an exact same-origin Origin header, including login.
    if !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS)
        && req
            .headers()
            .get(header::ORIGIN)
            .and_then(|h| h.to_str().ok())
            != Some(app.origin.as_str())
    {
        return Error(StatusCode::FORBIDDEN, "Origin rejected").into_response();
    }
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(header::CONTENT_SECURITY_POLICY,"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'".parse().unwrap());
    h.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    h.insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    h.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    h.insert(
        "permissions-policy",
        "camera=(), microphone=(), geolocation=()".parse().unwrap(),
    );
    if app.secure_cookie {
        h.insert(
            header::STRICT_TRANSPORT_SECURITY,
            "max-age=31536000".parse().unwrap(),
        );
    }
    res
}

pub fn valid_public_key(key: &str) -> bool {
    STANDARD
        .decode(key)
        .ok()
        .and_then(|bytes| VerifyingKey::from_public_key_der(&bytes).ok())
        .is_some()
}

pub fn verify_device(app: &App, headers: &HeaderMap, path: &str, body: &[u8]) -> ApiResult<String> {
    let get = |key: &str| -> ApiResult<&str> {
        headers
            .get(key)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(denied)
    };
    let id = get("x-bungee-device")?;
    let time = get("x-bungee-time")?;
    let nonce = get("x-bungee-nonce")?;
    if id.len() > 64
        || nonce.len() < 16
        || nonce.len() > 96
        || !nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(denied());
    }
    let stamp: i64 = time.parse().map_err(|_| denied())?;
    if now().abs_diff(stamp) > 120 {
        return Err(denied());
    }
    let db = app.db.lock().unwrap();
    let key: Option<String> = db
        .query_row(
            "SELECT public_key FROM devices WHERE id=? AND revoked=0 AND public_key IS NOT NULL",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    let key = key.ok_or_else(denied)?;
    let der = STANDARD.decode(key).map_err(|_| denied())?;
    let verify = VerifyingKey::from_public_key_der(&der).map_err(|_| denied())?;
    let sig = STANDARD
        .decode(get("x-bungee-signature")?)
        .map_err(|_| denied())?;
    let sig = Signature::from_der(&sig).map_err(|_| denied())?;
    let message = format!("BUNGEE-V1\nPOST\n{path}\n{time}\n{nonce}\n{}", hash(body));
    verify
        .verify(message.as_bytes(), &sig)
        .map_err(|_| denied())?;
    let update = path == "/v1/app-update/chunk";
    rate_limit(
        app,
        if update {
            RateClass::UpdateIdentity
        } else {
            RateClass::DeviceIdentity
        },
        id.to_owned(),
        if update { 1000 } else { 240 },
    )?;
    db.execute("DELETE FROM nonces WHERE created < ?", [now() - 300])?;
    let inserted = db.execute(
        "INSERT OR IGNORE INTO nonces(device_id,nonce,created) VALUES(?,?,?)",
        params![id, nonce, now()],
    )?;
    if inserted != 1 {
        return Err(Error(StatusCode::CONFLICT, "Request already used"));
    }
    db.execute(
        "UPDATE devices SET last_contact=MAX(COALESCE(last_contact,0),?) WHERE id=? AND revoked=0",
        params![now(), id],
    )?;
    Ok(id.into())
}

pub fn private_dir(_path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(_path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
pub fn private_file(_path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(_path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
pub fn private_write(path: &Path, data: &[u8]) -> io::Result<()> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(data)?;
    f.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn admin_bind_is_numeric_and_nonzero() {
        for address in [
            "127.0.0.1:8080",
            "[::1]:8080",
            "0.0.0.0:8443",
            "[::]:8443",
            "192.168.1.5:8443",
        ] {
            assert!(admin_bind(address).is_ok());
        }
        for address in [
            "224.0.0.1:8443",
            "localhost:8080",
            "127.0.0.1:0",
            "10.77.0.1:8443",
            "[::ffff:10.77.0.2]:8443",
        ] {
            assert!(admin_bind(address).is_err());
        }
    }
    #[test]
    fn management_prefixes_cannot_include_any_phone_overlay_address() {
        for value in [
            "10.0.0.0/8",
            "10.77.0.0/24",
            "10.77.0.2",
            "10.77.0.255/32",
            "::ffff:10.77.0.2",
            "192.168.1.0/24,10.77.0.0/25",
        ] {
            assert!(parse_admin_networks(value, true).is_err(), "{value}");
        }
        assert!(parse_admin_networks("10.76.0.0/16 192.168.1.0/24 fd12::/64", true).is_ok());
    }
    #[test]
    fn phone_sources_are_denied_even_with_a_permissive_in_memory_acl() {
        let broad = vec!["0.0.0.0/0".parse().unwrap(), "::/0".parse().unwrap()];
        for value in ["10.77.0.1", "10.77.0.2", "10.77.0.254", "::ffff:10.77.0.2"] {
            assert!(
                !administrator_source(value.parse().unwrap(), &broad),
                "{value}"
            );
        }
        assert!(administrator_source("192.168.1.5".parse().unwrap(), &broad));
    }
    #[test]
    fn full_source_bucket_preserves_existing_peers_and_other_classes() {
        let mut limits = RateLimits::default();
        limits
            .check(RateClass::DeviceSource, "known".into(), 600, 1000)
            .unwrap();
        for n in 0..4095 {
            limits
                .check(RateClass::DeviceSource, n.to_string(), 600, 1000)
                .unwrap();
        }
        assert!(
            limits
                .check(RateClass::DeviceSource, "new".into(), 600, 1000)
                .is_err()
        );
        limits
            .check(RateClass::DeviceSource, "known".into(), 600, 1000)
            .unwrap();
        limits
            .check(RateClass::AdminSource, "admin".into(), 5, 1000)
            .unwrap();
        limits
            .check(RateClass::DeviceIdentity, "phone".into(), 240, 1000)
            .unwrap();
        limits
            .check(RateClass::DeviceSource, "new".into(), 600, 1060)
            .unwrap();
    }
    #[test]
    fn denied_counter_saturates_instead_of_wrapping() {
        let mut limits = RateLimits::default();
        for _ in 0..70000 {
            let _ = limits.check(RateClass::AdminSource, "source".into(), 5, 1000);
        }
        assert!(
            limits
                .check(RateClass::AdminSource, "source".into(), 5, 1000)
                .is_err()
        );
    }
}
