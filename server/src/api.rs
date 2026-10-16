use crate::{App, security::*, store};
use axum::{
    Json,
    body::Bytes,
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use p256::{
    ecdsa::{Signature, VerifyingKey, signature::Verifier},
    pkcs8::DecodePublicKey,
};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fs, net::SocketAddr};

pub async fn health() -> Json<Value> {
    Json(json!({"status":"ok","version":env!("CARGO_PKG_VERSION")}))
}

#[derive(Deserialize)]
pub struct Login {
    password: String,
}
pub async fn login(
    State(app): State<App>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(input): Json<Login>,
) -> ApiResult<impl IntoResponse> {
    rate_limit(&app, format!("login:{}", addr.ip()), 5)?;
    if input.password.len() > 1024 {
        return Err(denied());
    }
    let expected = app.admin_hash.clone();
    let valid = tokio::task::spawn_blocking(move || password_matches(&input.password, &expected))
        .await
        .unwrap_or(false);
    if !valid {
        return Err(denied());
    }
    let value = token();
    let db = app.db.lock().unwrap();
    db.execute("DELETE FROM sessions WHERE expires<?", [now()])?;
    db.execute(
        "INSERT INTO sessions(hash,expires) VALUES(?,?)",
        params![hash(&value), now() + 3600 * 8],
    )?;
    store::audit(&db, "admin.login", None, "")?;
    let cookie = format!(
        "bungee_session={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800{}",
        if app.secure_cookie { "; Secure" } else { "" }
    );
    Ok((
        [(header::SET_COOKIE, cookie)],
        Json(json!({"authenticated":true})),
    ))
}
pub async fn session(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    Ok(Json(
        json!({"authenticated":true,"origin":app.origin,"wireguard_ready":app.state_dir.join("wireguard/server-public-key").exists()}),
    ))
}
pub async fn logout(State(app): State<App>, headers: HeaderMap) -> ApiResult<impl IntoResponse> {
    require_admin(&app, &headers)?;
    if let Some(value) = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|c| {
            c.split(';')
                .map(str::trim)
                .find_map(|c| c.strip_prefix("bungee_session="))
        })
    {
        app.db
            .lock()
            .unwrap()
            .execute("DELETE FROM sessions WHERE hash=?", [hash(value)])?;
    }
    Ok((
        [(
            header::SET_COOKIE,
            "bungee_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
        )],
        StatusCode::NO_CONTENT,
    ))
}

pub async fn devices(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let db = app.db.lock().unwrap();
    // The first release retains a single last-known point for at most 24 hours, not a travel history.
    db.execute(
        "UPDATE devices SET telemetry=NULL WHERE last_seen<?",
        [now() - 86400],
    )?;
    let mut q=db.prepare("SELECT id,name,address,created,last_seen,revoked,telemetry,capabilities,public_key IS NOT NULL FROM devices ORDER BY created")?;
    let rows=q.query_map([],|r|Ok(json!({
        "id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"address":r.get::<_,String>(2)?,
        "created":r.get::<_,i64>(3)?,"last_seen":r.get::<_,Option<i64>>(4)?,"revoked":r.get::<_,bool>(5)?,
        "telemetry":r.get::<_,Option<String>>(6)?.and_then(|s|serde_json::from_str::<Value>(&s).ok()),
        "capabilities":serde_json::from_str::<Value>(&r.get::<_,String>(7)?).unwrap_or(json!([])),
        "enrolled":r.get::<_,bool>(8)?,
    })))?.collect::<Result<Vec<_>,_>>()?;
    let mut q=db.prepare("SELECT id,device_id,kind,created,expires,status,result FROM commands ORDER BY created DESC LIMIT 50")?;
    let commands=q.query_map([],|r| Ok(json!({"id":r.get::<_,String>(0)?,"device_id":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"created":r.get::<_,i64>(3)?,"expires":r.get::<_,i64>(4)?,"status":if r.get::<_,i64>(4)?<now() && ["pending","delivered"].contains(&r.get::<_,String>(5)?.as_str()) {"expired".to_owned()} else {r.get(5)?},"result":r.get::<_,Option<String>>(6)?})))?.collect::<Result<Vec<_>,_>>()?;
    Ok(Json(
        json!({"devices":rows,"commands":commands,"server_time":now()}),
    ))
}

#[derive(Deserialize)]
pub struct Enrollment {
    name: String,
    wg_public_key: String,
}
fn wg_key(key: &str) -> bool {
    STANDARD
        .decode(key)
        .is_ok_and(|v| v.len() == 32 && v.iter().any(|b| *b != 0))
}
fn sync_peers(app: &App, db: &rusqlite::Connection) -> ApiResult<()> {
    let dir = app.state_dir.join("wireguard");
    fs::create_dir_all(&dir)?;
    private_dir(&dir)?;
    let mut q=db.prepare("SELECT wg_key,address FROM devices WHERE revoked=0 AND (public_key IS NOT NULL OR id IN (SELECT device_id FROM enrollments WHERE expires>?))")?;
    let rows = q.query_map([now()], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut text = String::new();
    for row in rows {
        let (key, ip) = row?;
        text.push_str(&format!(
            "[Peer]\nPublicKey = {key}\nAllowedIPs = {ip}/32\n\n"
        ));
    }
    let temp = dir.join("peers.next");
    // Only this process writes this file, while holding the database lock.
    if temp.exists() {
        fs::remove_file(&temp)?;
    }
    private_write(&temp, text.as_bytes())?;
    fs::rename(temp, dir.join("peers.conf"))?;
    Ok(())
}

pub fn housekeeping(app: &App) -> ApiResult<()> {
    let db = app.db.lock().unwrap();
    db.execute(
        "UPDATE devices SET telemetry=NULL WHERE last_seen<?",
        [now() - 86400],
    )?;
    db.execute("DELETE FROM commands WHERE created<?", [now() - 86400])?;
    db.execute("DELETE FROM sessions WHERE expires<?", [now()])?;
    db.execute("DELETE FROM enrollments WHERE expires<?", [now()])?;
    sync_peers(app, &db)?;
    Ok(())
}
pub async fn create_enrollment(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Enrollment>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    if input.name.trim().is_empty()
        || input.name.chars().count() > 60
        || input.name.chars().any(char::is_control)
        || !wg_key(&input.wg_public_key)
    {
        return Err(bad("Enter a device name and a valid WireGuard public key"));
    }
    let endpoint = app.wg_endpoint.clone().ok_or(Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "WireGuard gateway is not configured",
    ))?;
    let key =
        fs::read_to_string(app.state_dir.join("wireguard/server-public-key")).map_err(|_| {
            Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "WireGuard gateway is not ready",
            )
        })?;
    if !wg_key(key.trim()) {
        return Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Invalid gateway public key",
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let code = token();
    let db = app.db.lock().unwrap();
    let existing: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM devices WHERE wg_key=?)",
        [&input.wg_public_key],
        |r| r.get(0),
    )?;
    if existing {
        return Err(bad(
            "This phone key is already registered; reset pairing on the phone to generate a new one",
        ));
    }
    let used = db
        .prepare("SELECT address FROM devices")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let address = (2..=254)
        .map(|n| format!("10.77.0.{n}"))
        .find(|ip| !used.contains(ip))
        .ok_or(bad("Household device limit reached"))?;
    db.execute(
        "INSERT INTO devices(id,name,wg_key,address,created) VALUES(?,?,?,?,?)",
        params![id, input.name.trim(), input.wg_public_key, address, now()],
    )?;
    db.execute(
        "INSERT INTO enrollments(hash,device_id,expires) VALUES(?,?,?)",
        params![hash(&code), id, now() + 600],
    )?;
    sync_peers(&app, &db)?;
    store::audit(
        &db,
        "enrollment.created",
        Some(&id),
        "Expires in 10 minutes",
    )?;
    Ok(Json(
        json!({"version":1,"device_id":id,"name":input.name.trim(),"token":code,"expires":now()+600,
      "wireguard":{"endpoint":endpoint,"server_public_key":key.trim(),"client_public_key":input.wg_public_key,"address":format!("{address}/32"),"allowed_ip":"10.77.0.1/32"},
      "api_url":"http://10.77.0.1:8081"}),
    ))
}

#[derive(Deserialize)]
pub struct Pair {
    token: String,
    public_key: String,
    wg_public_key: String,
    proof: String,
    capabilities: Vec<String>,
}
const CAPABILITIES: &[&str] = &[
    "locate",
    "ring",
    "stop_ringing",
    "message",
    "clear_message",
    "lock",
];
fn valid_capabilities(caps: &[String]) -> bool {
    caps.len() <= CAPABILITIES.len() && caps.iter().all(|c| CAPABILITIES.contains(&c.as_str()))
}
pub async fn enroll(
    State(app): State<App>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(input): Json<Pair>,
) -> ApiResult<Json<Value>> {
    rate_limit(&app, format!("pair:{}", addr.ip()), 10)?;
    if input.token.len() > 128
        || input.public_key.len() > 512
        || !valid_public_key(&input.public_key)
        || !valid_capabilities(&input.capabilities)
    {
        return Err(bad("Invalid enrollment"));
    }
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    let row: Option<(String,String,String)>=tx.query_row("SELECT d.id,d.address,d.wg_key FROM enrollments e JOIN devices d ON d.id=e.device_id WHERE e.hash=? AND e.expires>? AND d.revoked=0 AND d.public_key IS NULL",params![hash(&input.token),now()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let (id, address, wg) = row.ok_or_else(denied)?;
    if wg != input.wg_public_key
        || (addr.ip().to_string() != address && (!addr.ip().is_loopback() || app.secure_cookie))
    {
        return Err(denied());
    }
    let der = STANDARD.decode(&input.public_key).map_err(|_| denied())?;
    let key = VerifyingKey::from_public_key_der(&der).map_err(|_| denied())?;
    let signature = STANDARD
        .decode(&input.proof)
        .ok()
        .and_then(|v| Signature::from_der(&v).ok())
        .ok_or_else(denied)?;
    let proof = format!(
        "BUNGEE-ENROLL-V1\n{}\n{}\n{}",
        input.token, input.wg_public_key, input.public_key
    );
    key.verify(proof.as_bytes(), &signature)
        .map_err(|_| denied())?;
    tx.execute(
        "UPDATE devices SET public_key=?,capabilities=?,last_seen=? WHERE id=?",
        params![
            input.public_key,
            serde_json::to_string(&input.capabilities).unwrap(),
            now(),
            id
        ],
    )?;
    tx.execute("DELETE FROM enrollments WHERE device_id=?", [&id])?;
    store::audit(
        &tx,
        "device.enrolled",
        Some(&id),
        "Signing key bound to approved WireGuard peer",
    )?;
    tx.commit()?;
    Ok(Json(
        json!({"device_id":id,"telemetry_interval_seconds":60}),
    ))
}

#[derive(Deserialize, Serialize)]
pub struct Telemetry {
    battery: u8,
    charging: bool,
    location: Option<Location>,
    capabilities: Vec<String>,
    device_owner: bool,
}
#[derive(Deserialize, Serialize)]
pub struct Location {
    latitude: f64,
    longitude: f64,
    accuracy: f64,
    observed_at: i64,
}
pub async fn telemetry(
    State(app): State<App>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let id = verify_device(&app, &headers, "/v1/telemetry", &body)?;
    let input: Telemetry = serde_json::from_slice(&body).map_err(|_| bad("Invalid telemetry"))?;
    if input.battery > 100 || !valid_capabilities(&input.capabilities) {
        return Err(bad("Invalid telemetry values"));
    }
    if let Some(l) = &input.location
        && (!(-90.0..=90.0).contains(&l.latitude)
            || !(-180.0..=180.0).contains(&l.longitude)
            || !(0.0..=100000.0).contains(&l.accuracy)
            || l.observed_at > now() + 120
            || l.observed_at < now() - 86400)
    {
        return Err(bad("Invalid or expired location"));
    }
    let db = app.db.lock().unwrap();
    db.execute(
        "UPDATE devices SET telemetry=?,last_seen=?,capabilities=? WHERE id=? AND revoked=0",
        params![
            serde_json::to_string(&input).map_err(|_| bad("Invalid telemetry"))?,
            now(),
            serde_json::to_string(&input.capabilities).unwrap(),
            id
        ],
    )?;
    // Read these fields to keep the schema explicit while preserving the exact signed telemetry body.
    let _ = (input.charging, input.device_owner);
    Ok(Json(json!({"accepted":true,"server_time":now()})))
}

#[derive(Deserialize)]
pub struct Command {
    kind: String,
    message: Option<String>,
}
pub async fn command(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<Command>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    if !CAPABILITIES.contains(&input.kind.as_str()) {
        return Err(bad("Unsupported command"));
    }
    let text = input.message.unwrap_or_default();
    if input.kind == "message"
        && (text.trim().is_empty()
            || text.chars().count() > 240
            || text.chars().any(|c| c.is_control() && c != '\n'))
    {
        return Err(bad("Recovery messages must contain 1–240 characters"));
    }
    let db = app.db.lock().unwrap();
    let caps: Option<String> = db
        .query_row(
            "SELECT capabilities FROM devices WHERE id=? AND revoked=0 AND public_key IS NOT NULL",
            [&id],
            |r| r.get(0),
        )
        .optional()?;
    let caps: Vec<String> = serde_json::from_str(
        &caps.ok_or(Error(StatusCode::NOT_FOUND, "Enrolled device not found"))?,
    )
    .unwrap_or_default();
    if !caps.contains(&input.kind) {
        return Err(bad("The phone has not granted this capability"));
    }
    let pending:i64=db.query_row("SELECT count(*) FROM commands WHERE device_id=? AND status IN ('pending','delivered') AND expires>?",params![id,now()],|r|r.get(0))?;
    if pending >= 10 {
        return Err(bad("Too many commands awaiting delivery"));
    }
    let cmd = uuid::Uuid::new_v4().to_string();
    let payload = json!({"message":text}).to_string();
    db.execute(
        "INSERT INTO commands(id,device_id,kind,payload,created,expires) VALUES(?,?,?,?,?,?)",
        params![cmd, id, input.kind, payload, now(), now() + 300],
    )?;
    store::audit(&db, "command.queued", Some(&id), &input.kind)?;
    Ok(Json(
        json!({"id":cmd,"status":"pending","expires":now()+300}),
    ))
}
pub async fn poll(
    State(app): State<App>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let id = verify_device(&app, &headers, "/v1/commands", &body)?;
    if body.as_ref() != b"{}" {
        return Err(bad("Expected empty object"));
    }
    let db = app.db.lock().unwrap();
    let mut q=db.prepare("SELECT id,kind,payload,expires FROM commands WHERE device_id=? AND status IN ('pending','delivered') AND expires>? ORDER BY created LIMIT 10")?;
    let list=q.query_map(params![id,now()],|r|Ok(json!({"id":r.get::<_,String>(0)?,"kind":r.get::<_,String>(1)?,"payload":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(json!({})),"expires":r.get::<_,i64>(3)?})))?.collect::<Result<Vec<_>,_>>()?;
    db.execute("UPDATE commands SET status='delivered' WHERE device_id=? AND status='pending' AND expires>?",params![id,now()])?;
    // Messages and command results are deleted after 24h; retain only bounded metadata in audit.
    db.execute("DELETE FROM commands WHERE created<?", [now() - 86400])?;
    Ok(Json(json!({"commands":list,"server_time":now()})))
}
#[derive(Deserialize)]
pub struct Ack {
    id: String,
    status: String,
    result: String,
}
pub async fn ack(
    State(app): State<App>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let id = verify_device(&app, &headers, "/v1/ack", &body)?;
    let input: Ack = serde_json::from_slice(&body).map_err(|_| bad("Invalid receipt"))?;
    if !["executed", "rejected", "failed"].contains(&input.status.as_str())
        || input.result.len() > 256
    {
        return Err(bad("Invalid receipt values"));
    }
    let db = app.db.lock().unwrap();
    let changed=db.execute("UPDATE commands SET status=?,result=? WHERE id=? AND device_id=? AND status='delivered' AND expires>?",params![input.status,input.result,input.id,id,now()])?;
    if changed == 1 {
        store::audit(&db, "command.receipt", Some(&id), &input.status)?;
    }
    Ok(Json(json!({"accepted":changed==1})))
}
pub async fn revoke(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let db = app.db.lock().unwrap();
    let changed = db.execute(
        "UPDATE devices SET revoked=1,telemetry=NULL,capabilities='[]' WHERE id=? AND revoked=0",
        [&id],
    )?;
    if changed != 1 {
        return Err(Error(StatusCode::NOT_FOUND, "Device not found"));
    }
    db.execute("DELETE FROM enrollments WHERE device_id=?", [&id])?;
    db.execute("DELETE FROM commands WHERE device_id=?", [&id])?;
    sync_peers(&app, &db)?;
    store::audit(
        &db,
        "device.revoked",
        Some(&id),
        "Telemetry erased; WireGuard peer removed",
    )?;
    Ok(Json(json!({"revoked":true})))
}
pub async fn audit(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let db = app.db.lock().unwrap();
    let mut q =
        db.prepare("SELECT at,action,device_id,detail FROM audit ORDER BY id DESC LIMIT 100")?;
    let rows=q.query_map([],|r|Ok(json!({"at":r.get::<_,i64>(0)?,"action":r.get::<_,String>(1)?,"device_id":r.get::<_,Option<String>>(2)?,"detail":r.get::<_,String>(3)?})))?.collect::<Result<Vec<_>,_>>()?;
    Ok(Json(json!({"events":rows})))
}
