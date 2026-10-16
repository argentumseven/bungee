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
use std::net::SocketAddr;

pub async fn health() -> Json<Value> {
    Json(json!({"status":"ok","version":crate::release::version()}))
}

#[derive(Deserialize)]
pub struct Login {
    password: String,
}
static LOGIN_WORK: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
pub async fn login(
    State(app): State<App>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(input): Json<Login>,
) -> ApiResult<impl IntoResponse> {
    let source = admin_source(addr.ip(), &headers, app.trust_admin_proxy)?;
    rate_limit(&app, RateClass::AdminSource, source.to_string(), 5)?;
    rate_limit(&app, RateClass::AdminAggregate, "household".into(), 30)?;
    if input.password.len() > 1024 {
        return Err(denied());
    }
    let expected = app.admin_hash.clone();
    let permit = LOGIN_WORK
        .try_acquire()
        .map_err(|_| Error(StatusCode::TOO_MANY_REQUESTS, "Please retry later"))?;
    let valid = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        password_matches(&input.password, &expected)
    })
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
    let mut q=db.prepare("SELECT id,name,address,created,last_seen,revoked,telemetry,capabilities,public_key IS NOT NULL,last_location,wg_psk IS NOT NULL,management_report,last_contact,(SELECT MAX(expires) FROM enrollments WHERE device_id=devices.id),wg_key FROM devices ORDER BY created")?;
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
        "enrollment_state":if r.get::<_,bool>(5)? {"revoked"} else if r.get::<_,bool>(8)? {"enrolled"} else if r.get::<_,Option<i64>>(13)?.is_some_and(|v|v>now()) {"pending"} else {"expired"},
        "invitation_expires_at":r.get::<_,Option<i64>>(13)?,
        "wg_public_key":r.get::<_,String>(14)?,
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
    rate_limit(&app, RateClass::Enrollment, addr.ip().to_string(), 10)?;
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
    let changed = tx.execute("UPDATE devices SET history_revision=history_revision+1,
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
    // A delayed receipt reports an earlier attempt; it never extends execution authority.
    // A restored server may not know an offered command yet. Preserve the phone's
    // journal in every non-matching case so later polls/restoration can reconcile it.
    let received = now();
    let row: Option<(String, Option<String>, i64, i64, String)> = db
        .query_row(
            "SELECT status,result,created,expires,kind FROM commands WHERE id=? AND device_id=?",
            params![input.id, id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    let disposition = match row {
        None => "unknown_command",
        Some((status, result, created, expires, kind)) => {
            let offered = status == "delivered"
                || (status == "accepted" && kind == "reboot" && input.status == "failed");
            if !offered && status != "pending" {
                if status == input.status && result.as_deref() == Some(input.result.as_str()) {
                    "already_terminal"
                } else {
                    "conflicting_terminal"
                }
            } else if created < received - 86400 {
                "retention_elapsed"
            } else if input
                .attempted_at
                .is_some_and(|at| at < created || at >= expires)
            {
                "invalid_attempt"
            } else if expires <= received && input.attempted_at.is_none() {
                "expired"
            } else if !offered {
                "not_offered"
            } else if input.status == "accepted" && kind != "reboot" {
                "invalid_status"
            } else {
                db.execute("UPDATE commands SET status=?,result=?,receipt_received_at=? WHERE id=? AND device_id=?",
                    params![input.status,input.result,received,input.id,id])?;
                "recorded"
            }
        }
    };
    if disposition == "recorded" {
        store::audit(&db, "command.receipt", Some(&id), &input.status)?;
    }
    Ok(Json(
        json!({"accepted":disposition=="recorded","settled":(["recorded","already_terminal"].contains(&disposition)),"receipt_status":disposition,"server_time":received}),
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
    crate::enrollment::sync_peers(&app, &db)?;
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
