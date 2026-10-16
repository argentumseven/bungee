use crate::{App, security::*, store};
use axum::{
    Json,
    body::Bytes,
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use p256::{
    ecdsa::{Signature, VerifyingKey, signature::Verifier},
    pkcs8::DecodePublicKey,
};
use rand::RngCore;
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
    if let Err(e) = crate::geography::collect(&app) {
        tracing::error!(error=%e.1, "Network observation unavailable; saved device state remains accessible");
    }
    let db = app.db.lock().unwrap();
    // Recovery data survives long outages. Freshness is described by timestamps, not deletion.
    let mut q=db.prepare("SELECT id,name,address,created,last_seen,revoked,telemetry,capabilities,public_key IS NOT NULL,last_location,wg_psk IS NOT NULL,management_report,last_contact FROM devices ORDER BY created")?;
    let rows=q.query_map([],|r| {
        let location = r.get::<_,Option<String>>(9)?.and_then(|s|serde_json::from_str::<Value>(&s).ok());
        let mut telemetry = r.get::<_,Option<String>>(6)?.and_then(|s|serde_json::from_str::<Value>(&s).ok());
        // Keep the existing response shape, while storing the latest fix independently.
        if let Some(Value::Object(ref mut state)) = telemetry {
            state.insert("location".into(), location.unwrap_or(Value::Null));
        }
        Ok(json!({
        "id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"address":r.get::<_,String>(2)?,
        "created":r.get::<_,i64>(3)?,"last_seen":r.get::<_,Option<i64>>(4)?,"revoked":r.get::<_,bool>(5)?,
        "telemetry":telemetry,"last_contact":r.get::<_,Option<i64>>(12)?,
        "network":crate::geography::latest(&db,&r.get::<_,String>(0)?)?,
        "capabilities":serde_json::from_str::<Vec<String>>(&r.get::<_,String>(7)?).unwrap_or_default().into_iter().filter(|kind|kind!="reboot").collect::<Vec<_>>(),
        "enrolled":r.get::<_,bool>(8)?,
        "preshared_key":r.get::<_,bool>(10)?,
        "management":r.get::<_,Option<String>>(11)?.and_then(|s|serde_json::from_str::<Value>(&s).ok()),
    }))})?.collect::<Result<Vec<_>,_>>()?;
    let mut q=db.prepare("SELECT id,device_id,kind,created,expires,status,result,receipt_received_at FROM commands ORDER BY created DESC LIMIT 50")?;
    let commands=q.query_map([],|r| Ok(json!({"id":r.get::<_,String>(0)?,"device_id":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"created":r.get::<_,i64>(3)?,"expires":r.get::<_,i64>(4)?,"status":if r.get::<_,i64>(4)?<now() && ["pending","delivered"].contains(&r.get::<_,String>(5)?.as_str()) {"expired".to_owned()} else {r.get(5)?},"result":r.get::<_,Option<String>>(6)?,"receipt_received_at":r.get::<_,Option<i64>>(7)?,"delivery_uncertain":r.get::<_,String>(5)?=="delivered" && r.get::<_,i64>(4)?<now()})))?.collect::<Result<Vec<_>,_>>()?;
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
    // Legacy peers stay recorded for recovery/history but may not bypass mandatory PSK protection.
    let mut q=db.prepare("SELECT wg_key,address,wg_psk FROM devices WHERE revoked=0 AND wg_psk IS NOT NULL AND (public_key IS NOT NULL OR id IN (SELECT device_id FROM enrollments WHERE expires>?))")?;
    let rows = q.query_map([now()], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut text = String::new();
    for row in rows {
        let (key, ip, psk) = row?;
        if !wg_key(&key) || !wg_key(&psk) || ip.parse::<std::net::Ipv4Addr>().is_err() {
            return Err(bad("Invalid stored peer configuration"));
        }
        text.push_str(&format!(
            "[Peer]\nPublicKey = {key}\nPresharedKey = {psk}\nAllowedIPs = {ip}/32\n\n"
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
    let mut psk = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut psk);
    let psk = STANDARD.encode(psk);
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
        "INSERT INTO devices(id,name,wg_key,address,created,wg_psk) VALUES(?,?,?,?,?,?)",
        params![
            id,
            input.name.trim(),
            input.wg_public_key,
            address,
            now(),
            psk
        ],
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
        json!({"version":2,"device_id":id,"name":input.name.trim(),"token":code,"expires":now()+600,
      "wireguard":{"endpoint":endpoint,"server_public_key":key.trim(),"client_public_key":input.wg_public_key,"preshared_key":psk,"address":format!("{address}/32"),"allowed_ip":"10.77.0.1/32"},
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
    "reboot",
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
    let row: Option<(String,String,String)>=tx.query_row("SELECT d.id,d.address,d.wg_key FROM enrollments e JOIN devices d ON d.id=e.device_id WHERE e.hash=? AND e.expires>? AND d.revoked=0 AND d.public_key IS NULL AND d.wg_psk IS NOT NULL",params![hash(&input.token),now()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
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
    #[serde(default, skip_serializing)]
    locations: Vec<Location>,
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
    let mut input: Telemetry =
        serde_json::from_slice(&body).map_err(|_| bad("Invalid telemetry"))?;
    if input.battery > 100 || !valid_capabilities(&input.capabilities) {
        return Err(bad("Invalid telemetry values"));
    }
    if input.locations.len() > 100 {
        return Err(bad("At most 100 queued GPS fixes per report"));
    }
    for l in input.location.iter().chain(&input.locations) {
        if !(-90.0..=90.0).contains(&l.latitude)
            || !(-180.0..=180.0).contains(&l.longitude)
            || !(0.0..=100000.0).contains(&l.accuracy)
            || l.observed_at > now() + 120
            || l.observed_at <= 0
        {
            return Err(bad("Invalid location values or timestamp"));
        }
    }
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    let (mut location, floor): (Option<String>, i64) = tx
        .query_row(
            "SELECT last_location,location_floor FROM devices WHERE id=? AND revoked=0",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(denied)?;
    let mut previous = location
        .as_deref()
        .map(serde_json::from_str::<Location>)
        .transpose()
        .map_err(|_| {
            Error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Stored location could not be read",
            )
        })?;
    let received = now();
    let mut fixes = std::mem::take(&mut input.locations);
    if let Some(fix) = input.location.take() {
        fixes.push(fix);
    }
    for fix in fixes.into_iter().filter(|f| f.observed_at > floor) {
        // Keep backfilled points in history without moving the last-known point backwards.
        tx.execute("INSERT OR IGNORE INTO location_history(device_id,observed_at,received_at,latitude,longitude,accuracy) VALUES(?,?,?,?,?,?)",
            params![id,fix.observed_at,received,fix.latitude,fix.longitude,fix.accuracy])?;
        if previous
            .as_ref()
            .is_none_or(|old| fix.observed_at > old.observed_at)
        {
            location = Some(serde_json::to_string(&fix).map_err(|_| bad("Invalid location"))?);
            previous = Some(fix);
        }
    }
    tx.execute("INSERT INTO state_history(device_id,received_at,battery,charging,device_owner) VALUES(?,?,?,?,?)",
        params![id,received,input.battery,input.charging,input.device_owner])?;
    tx.execute(
        "UPDATE devices SET telemetry=?,last_location=?,last_seen=?,capabilities=? WHERE id=? AND revoked=0",
        params![
            serde_json::to_string(&input).map_err(|_| bad("Invalid telemetry"))?,
            location,
            received,
            serde_json::to_string(&input.capabilities).unwrap(),
            id
        ],
    )?;
    tx.commit()?;
    Ok(Json(json!({"accepted":true,"server_time":now()})))
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    from: i64,
    to: i64,
    before: Option<i64>,
    limit: Option<usize>,
    kind: Option<String>,
    every: Option<i64>,
    daily: Option<String>,
    timezone: Option<String>,
    tolerance: Option<i64>,
}
pub async fn history(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<HistoryQuery>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let limit = query.limit.unwrap_or(200);
    if query.from < 0
        || query.to < query.from
        || !(1..=1000).contains(&limit)
        || query.before.is_some_and(|v| v <= 0)
    {
        return Err(bad(
            "Use an ordered Unix-second range and a limit from 1 to 1000",
        ));
    }
    let kind = query.kind.as_deref().unwrap_or("locations");
    if !["locations", "state", "network"].contains(&kind) {
        return Err(bad("Unknown history kind"));
    }
    let recurrence = crate::recurrence::Recurrence {
        every: query.every,
        daily: query.daily,
        timezone: query.timezone,
        tolerance: query.tolerance,
    };
    recurrence.validate(query.from, query.to)?;
    let db = app.db.lock().unwrap();
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM devices WHERE id=?)",
        [&id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(Error(StatusCode::NOT_FOUND, "Device not found"));
    }
    let selected = recurrence.keys(
        &db,
        &id,
        kind,
        query.from,
        query.to,
        query.before.unwrap_or(i64::MAX),
        limit,
    )?;
    let mut rows: Vec<Value> = if let Some(keys) = selected {
        let mut result = Vec::new();
        if kind == "locations" {
            let mut q = db.prepare("SELECT observed_at,received_at,latitude,longitude,accuracy FROM location_history WHERE device_id=? AND observed_at=?")?;
            for key in keys {
                result.push(q.query_row(params![id,key], |r| Ok(json!({"observed_at":r.get::<_,i64>(0)?,"received_at":r.get::<_,i64>(1)?,"latitude":r.get::<_,f64>(2)?,"longitude":r.get::<_,f64>(3)?,"accuracy":r.get::<_,f64>(4)?})))?);
            }
        } else if kind == "network" {
            let mut q = db.prepare("SELECT observed_at,received_at,ip,geoip FROM network_history WHERE device_id=? AND observed_at=?")?;
            for key in keys {
                result.push(q.query_row(params![id, key], crate::geography::record)?);
            }
        } else {
            let mut q = db.prepare("SELECT id,received_at,battery,charging,device_owner FROM state_history WHERE device_id=? AND id=?")?;
            for key in keys {
                result.push(q.query_row(params![id,key], |r| Ok(json!({"id":r.get::<_,i64>(0)?,"received_at":r.get::<_,i64>(1)?,"battery":r.get::<_,u8>(2)?,"charging":r.get::<_,bool>(3)?,"device_owner":r.get::<_,bool>(4)?})))?);
            }
        }
        result
    } else if kind == "locations" {
        let mut q = db.prepare("SELECT observed_at,received_at,latitude,longitude,accuracy FROM location_history
            WHERE device_id=? AND observed_at>=? AND observed_at<=? AND observed_at<? ORDER BY observed_at DESC LIMIT ?")?;
        q.query_map(params![id,query.from,query.to,query.before.unwrap_or(i64::MAX),limit as i64 + 1], |r| {
            Ok(json!({"observed_at":r.get::<_,i64>(0)?,"received_at":r.get::<_,i64>(1)?,
                "latitude":r.get::<_,f64>(2)?,"longitude":r.get::<_,f64>(3)?,"accuracy":r.get::<_,f64>(4)?}))
        })?.collect::<Result<Vec<_>,_>>()?
    } else if kind == "network" {
        let mut q = db.prepare("SELECT observed_at,received_at,ip,geoip FROM network_history WHERE device_id=? AND observed_at>=? AND observed_at<=? AND observed_at<? ORDER BY observed_at DESC LIMIT ?")?;
        q.query_map(
            params![
                id,
                query.from,
                query.to,
                query.before.unwrap_or(i64::MAX),
                limit as i64 + 1
            ],
            crate::geography::record,
        )?
        .collect::<Result<Vec<_>, _>>()?
    } else {
        let mut q = db.prepare("SELECT id,received_at,battery,charging,device_owner FROM state_history
            WHERE device_id=? AND received_at>=? AND received_at<=? AND id<? ORDER BY id DESC LIMIT ?")?;
        q.query_map(params![id,query.from,query.to,query.before.unwrap_or(i64::MAX),limit as i64 + 1], |r| {
            Ok(json!({"id":r.get::<_,i64>(0)?,"received_at":r.get::<_,i64>(1)?,"battery":r.get::<_,u8>(2)?,
                "charging":r.get::<_,bool>(3)?,"device_owner":r.get::<_,bool>(4)?}))
        })?.collect::<Result<Vec<_>,_>>()?
    };
    let more = rows.len() > limit;
    rows.truncate(limit);
    let next = if more {
        rows.last()
            .and_then(|r| r[if kind != "state" { "observed_at" } else { "id" }].as_i64())
    } else {
        None
    };
    Ok(Json(
        json!({"kind":kind,"records":rows,"next_before":next,"from":query.from,"to":query.to}),
    ))
}

pub async fn clear_location(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    erase_history(&app, &headers, &id, false)
}
pub async fn clear_history(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    erase_history(&app, &headers, &id, true)
}
fn erase_history(
    app: &App,
    headers: &HeaderMap,
    id: &str,
    include_state: bool,
) -> ApiResult<Json<Value>> {
    require_admin(app, headers)?;
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    let changed = tx.execute("UPDATE devices SET
        location_floor=MAX(location_floor,COALESCE(json_extract(last_location,'$.observed_at'),0),?),
        last_location=NULL WHERE id=? AND revoked=0 AND public_key IS NOT NULL", params![now(),id])?;
    if changed != 1 {
        return Err(Error(StatusCode::NOT_FOUND, "Enrolled device not found"));
    }
    tx.execute("DELETE FROM location_history WHERE device_id=?", [id])?;
    if include_state {
        tx.execute("DELETE FROM state_history WHERE device_id=?", [id])?;
        tx.execute(
            "UPDATE devices SET network_floor=MAX(network_floor,COALESCE((SELECT MAX(observed_at) FROM network_history WHERE device_id=?),0),?) WHERE id=?",
            params![id, now(), id],
        )?;
        tx.execute("DELETE FROM network_history WHERE device_id=?", [id])?;
    }
    store::audit(
        &tx,
        if include_state {
            "history.erased"
        } else {
            "location.erased"
        },
        Some(id),
        "Saved GPS points erased; cached older fixes will not restore them",
    )?;
    tx.commit()?;
    Ok(Json(json!({"cleared":true})))
}

#[derive(Deserialize)]
pub struct Command {
    kind: String,
    message: Option<String>,
    #[serde(rename = "password")]
    _password: Option<String>,
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
    if input.kind == "reboot" {
        return Err(bad("Remote reboot is disabled by the reversibility policy"));
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
    db.execute("UPDATE commands SET status='rejected',result='Disabled by reversibility policy' WHERE device_id=? AND kind='reboot' AND status IN ('pending','delivered')", [&id])?;
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
    attempted_at: Option<i64>,
}
pub async fn ack(
    State(app): State<App>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let id = verify_device(&app, &headers, "/v1/ack", &body)?;
    let input: Ack = serde_json::from_slice(&body).map_err(|_| bad("Invalid receipt"))?;
    if !["executed", "rejected", "failed", "accepted"].contains(&input.status.as_str())
        || input.result.len() > 256
        || input
            .attempted_at
            .is_some_and(|v| v <= 0 || v > now() + 120)
    {
        return Err(bad("Invalid receipt values"));
    }
    let db = app.db.lock().unwrap();
    // A delayed receipt reports an earlier attempt; it never makes an expired command executable.
    // Replays cannot rewrite a terminal result, and pending (never delivered) commands cannot be acknowledged.
    let received = now();
    let changed=db.execute("UPDATE commands SET status=?,result=?,receipt_received_at=? WHERE id=? AND device_id=? AND (?!='accepted' OR kind='reboot') AND (status='delivered' OR (status='accepted' AND kind='reboot' AND ?='failed')) AND created>=? AND (expires>? OR (? IS NOT NULL AND ?>=created AND ?<expires))",
        params![input.status,input.result,received,input.id,id,input.status,input.status,received-86400,received,input.attempted_at,input.attempted_at,input.attempted_at])?;
    if changed == 1 {
        store::audit(&db, "command.receipt", Some(&id), &input.status)?;
    }
    // A definitive rejection/terminal result can leave the phone's outbox; transport failures cannot.
    Ok(Json(
        json!({"accepted":changed==1,"settled":true,"server_time":received}),
    ))
}
pub async fn revoke(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    let changed = tx.execute(
        "UPDATE devices SET revoked=1,telemetry=NULL,last_location=NULL,wg_psk=NULL,management_report=NULL,capabilities='[]' WHERE id=? AND revoked=0",
        [&id],
    )?;
    if changed != 1 {
        return Err(Error(StatusCode::NOT_FOUND, "Device not found"));
    }
    tx.execute("DELETE FROM enrollments WHERE device_id=?", [&id])?;
    tx.execute("DELETE FROM commands WHERE device_id=?", [&id])?;
    tx.execute("DELETE FROM location_history WHERE device_id=?", [&id])?;
    tx.execute("DELETE FROM state_history WHERE device_id=?", [&id])?;
    tx.execute("DELETE FROM network_history WHERE device_id=?", [&id])?;
    tx.execute("DELETE FROM dns_summary WHERE device_id=?", [&id])?;
    tx.execute("DELETE FROM device_policies WHERE device_id=?", [&id])?;
    store::audit(
        &tx,
        "device.revoked",
        Some(&id),
        "Telemetry erased; WireGuard peer removed",
    )?;
    tx.commit()?;
    // Authentication is already revoked if filesystem synchronization fails; housekeeping retries it.
    sync_peers(&app, &db)?;
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
