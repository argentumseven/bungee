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
    path::Path,
};

pub type ApiResult<T> = Result<T, Error>;
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

#[derive(Default)]
pub struct RateLimits(HashMap<String, (i64, u16)>);
pub fn rate_limit(app: &App, key: String, limit: u16) -> ApiResult<()> {
    let mut all = app.limiter.lock().unwrap();
    all.0.retain(|_, (at, _)| now() - *at < 60);
    if all.0.len() >= 4096 {
        return Err(Error(StatusCode::TOO_MANY_REQUESTS, "Please retry later"));
    }
    let entry = all.0.entry(key).or_insert((now(), 0));
    entry.1 += 1;
    if entry.1 > limit {
        Err(Error(StatusCode::TOO_MANY_REQUESTS, "Please retry later"))
    } else {
        Ok(())
    }
}

pub fn require_admin(app: &App, headers: &HeaderMap) -> ApiResult<()> {
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
    let db = app.db.lock().unwrap();
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE hash=? AND expires>?)",
        params![hash(value), now()],
        |r| r.get(0),
    )?;
    if exists { Ok(()) } else { Err(denied()) }
}

pub async fn browser_guard(State(app): State<App>, req: Request, next: Next) -> Response {
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
    h.insert(header::CONTENT_SECURITY_POLICY,"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'".parse().unwrap());
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
    rate_limit(app, format!("device:{id}"), 240)?;
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
    db.execute("DELETE FROM nonces WHERE created < ?", [now() - 300])?;
    let inserted = db.execute(
        "INSERT OR IGNORE INTO nonces(device_id,nonce,created) VALUES(?,?,?)",
        params![id, nonce, now()],
    )?;
    if inserted != 1 {
        return Err(Error(StatusCode::CONFLICT, "Request already used"));
    }
    Ok(id.into())
}

pub fn private_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
pub fn private_file(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
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
