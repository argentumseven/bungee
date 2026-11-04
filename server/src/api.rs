use crate::{App, credentials, security::*, store};
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
    Json(input): Json<Login>,
) -> ApiResult<impl IntoResponse> {
    let source = addr.ip();
    rate_limit(&app, RateClass::AdminSource, source.to_string(), 5)?;
    rate_limit(&app, RateClass::AdminAggregate, "household".into(), 30)?;
    if input.password.len() > 1024 {
        return Err(Error(
            StatusCode::UNAUTHORIZED,
            "Incorrect administrator password",
        ));
    }
    let expected = credentials::current(&app.db.lock().unwrap())?.ok_or_else(denied)?;
    let checked = expected.clone();
    let permit = LOGIN_WORK
        .try_acquire()
        .map_err(|_| Error(StatusCode::TOO_MANY_REQUESTS, "Please retry later"))?;
    let valid = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let password = zeroize::Zeroizing::new(input.password);
        password_matches(&password, &checked)
    })
    .await
    .unwrap_or(false);
    if !valid {
        return Err(Error(
            StatusCode::UNAUTHORIZED,
            "Incorrect administrator password",
        ));
    }
    let value = token();
    let db = app.db.lock().unwrap();
    let tx = db.unchecked_transaction()?;
    // A reset/change while Argon2 was running must not issue an old-password session.
    if credentials::current(&tx)?.as_ref() != Some(&expected) {
        return Err(Error(
            StatusCode::UNAUTHORIZED,
            "Incorrect administrator password",
        ));
    }
    tx.execute("DELETE FROM sessions WHERE expires<?", [now()])?;
    tx.execute(
        "INSERT INTO sessions(hash,expires) VALUES(?,?)",
        params![hash(&value), now() + 3600 * 8],
    )?;
    store::audit(&tx, "admin.login", None, "")?;
    tx.commit()?;
    let cookie = format!(
        "bungee_session={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800{}",
        if app.secure_cookie { "; Secure" } else { "" }
    );
    Ok((
        [(header::SET_COOKIE, cookie)],
        Json(json!({"authenticated":true})),
    ))
}

#[derive(Deserialize)]
pub struct PasswordChange {
    current_password: String,
    new_password: String,
}

pub async fn change_password(
    State(app): State<App>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(input): Json<PasswordChange>,
) -> ApiResult<impl IntoResponse> {
    require_admin(&app, &headers)?;
    rate_limit(&app, RateClass::AdminSource, addr.ip().to_string(), 5)?;
    rate_limit(&app, RateClass::AdminAggregate, "household".into(), 30)?;
    let current = zeroize::Zeroizing::new(input.current_password);
    let new = zeroize::Zeroizing::new(input.new_password);
    if current.len() > 1024 {
        return Err(bad("Current password is too long"));
    }
    credentials::validate_password(&new).map_err(bad)?;
    let expected = credentials::current(&app.db.lock().unwrap())?.ok_or_else(denied)?;
    let checked = expected.clone();
    let permit = LOGIN_WORK
        .try_acquire()
        .map_err(|_| Error(StatusCode::TOO_MANY_REQUESTS, "Please retry later"))?;
    let replacement = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if !password_matches(&current, &checked) {
            return Err(bad("Current password is incorrect"));
        }
        if *current == *new {
            return Err(bad("Choose a different new password"));
        }
        password_hash(&new)
            .map_err(|_| Error(StatusCode::INTERNAL_SERVER_ERROR, "Password hashing failed"))
    })
    .await
    .map_err(|_| Error(StatusCode::INTERNAL_SERVER_ERROR, "Password change failed"))??;
    let db = app.db.lock().unwrap();
    require_admin_db(&db, &headers)?;
    if credentials::current(&db)?.as_ref() != Some(&expected) {
        return Err(bad("Password changed during this request; sign in again"));
    }
    // The verifier and session invalidation commit together, surviving restarts.
    if !credentials::change(&db, &expected, &replacement)? {
        return Err(bad("Password changed during this request; sign in again"));
    }
    Ok((
        [(
            header::SET_COOKIE,
            "bungee_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
        )],
        Json(json!({"changed":true})),
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
    if let Some(value) = session_cookie(&headers) {
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
    let mut q=db.prepare("SELECT id,name,address,created,last_seen,revoked,telemetry,capabilities,public_key IS NOT NULL,last_location,wg_psk IS NOT NULL,management_report,last_contact,(SELECT MAX(expires) FROM enrollments WHERE device_id=devices.id),wg_key,binding_released FROM devices ORDER BY created")?;
    let rows=q.query_map([],|r| {
        let location = r.get::<_,Option<String>>(9)?.and_then(|s|serde_json::from_str::<Value>(&s).ok());
        let mut telemetry = r.get::<_,Option<String>>(6)?.and_then(|s|serde_json::from_str::<Value>(&s).ok());
        // Keep the existing response shape, while storing the latest fix independently.
        if let Some(Value::Object(ref mut state)) = telemetry {
            state.insert("location".into(), location.clone().unwrap_or(Value::Null));
        }
        Ok(json!({
        "id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"address":r.get::<_,String>(2)?,
        "created":r.get::<_,i64>(3)?,"last_seen":r.get::<_,Option<i64>>(4)?,"revoked":r.get::<_,bool>(5)?,
        "telemetry":telemetry,"last_location":location,"last_contact":r.get::<_,Option<i64>>(12)?,
        "network":crate::geography::latest(&db,&r.get::<_,String>(0)?)?,
        "capabilities":serde_json::from_str::<Vec<String>>(&r.get::<_,String>(7)?).unwrap_or_default().into_iter().filter(|kind|kind!="reboot" && kind!="dns_check").collect::<Vec<_>>(),
        "enrolled":r.get::<_,bool>(8)?,
        "enrollment_state":if r.get::<_,bool>(5)? {"revoked"} else if r.get::<_,bool>(8)? {"enrolled"} else if r.get::<_,Option<i64>>(13)?.is_some_and(|v|v>now()) {"pending"} else {"expired"},
        "invitation_expires_at":r.get::<_,Option<i64>>(13)?,
        "wg_public_key":if r.get::<_,bool>(15)? {None} else {Some(r.get::<_,String>(14)?)},
        "binding_released":r.get::<_,bool>(15)?,
        "can_purge_binding":!r.get::<_,bool>(15)? && (r.get::<_,bool>(5)? || (!r.get::<_,bool>(8)? && r.get::<_,Option<i64>>(13)?.is_none_or(|v|v<=now()))),
        "preshared_key":r.get::<_,bool>(10)?,
        "management":r.get::<_,Option<String>>(11)?.and_then(|s|serde_json::from_str::<Value>(&s).ok()),
    }))})?.collect::<Result<Vec<_>,_>>()?;
    let mut q=db.prepare("SELECT id,device_id,kind,created,expires,status,result,receipt_received_at,canceled_at,canceled_after_offer FROM commands ORDER BY created DESC LIMIT 50")?;
    let commands=q.query_map([],|r| Ok(json!({"id":r.get::<_,String>(0)?,"device_id":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"created":r.get::<_,i64>(3)?,"expires":r.get::<_,i64>(4)?,"status":if r.get::<_,i64>(4)?<now() && ["pending","delivered"].contains(&r.get::<_,String>(5)?.as_str()) {"expired".to_owned()} else {r.get(5)?},"result":r.get::<_,Option<String>>(6)?,"receipt_received_at":r.get::<_,Option<i64>>(7)?,"canceled_at":r.get::<_,Option<i64>>(8)?,"canceled_after_offer":r.get::<_,bool>(9)?,"delivery_uncertain":r.get::<_,String>(5)?=="delivered" && r.get::<_,i64>(4)?<now()})))?.collect::<Result<Vec<_>,_>>()?;
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
    "best_guess",
    "ring",
    "ring_flash",
    "flash",
    "stop_ringing",
    "stop_all",
    "message",
    "clear_message",
    "lock",
    "reboot",
];
fn valid_capabilities(caps: &[String]) -> bool {
    // Accept and discard this retired capability from older phones during upgrades.
    caps.len() <= CAPABILITIES.len() + 1
        && caps
            .iter()
            .all(|c| c == "dns_check" || CAPABILITIES.contains(&c.as_str()))
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
    let gps_epoch = token();
    let photo_epoch = token();
    tx.execute(
        "UPDATE devices SET public_key=?,capabilities=?,last_seen=?,gps_epoch=?,photo_epoch=? WHERE id=?",
        params![
            input.public_key,
            serde_json::to_string(&input.capabilities.iter().filter(|kind|kind.as_str()!="dns_check").collect::<Vec<_>>()).unwrap(),
            now(),
            gps_epoch,
            photo_epoch,
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
        json!({"device_id":id,"gps_epoch":gps_epoch,"photo_epoch":photo_epoch,"telemetry_interval_seconds":60}),
    ))
}

#[derive(Deserialize, Serialize)]
pub struct Telemetry {
    #[serde(default, skip_serializing)]
    photo_epoch: Option<String>,
    #[serde(default, skip_serializing)]
    recovery_photo: Option<crate::photos::Photo>,
    #[serde(default, skip_serializing)]
    gps_epoch: Option<String>,
    #[serde(default, skip_serializing)]
    locate_command: Option<String>,
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
    #[serde(default = "passive_source")]
    source: String,
    #[serde(default = "one_sample")]
    samples: u32,
    #[serde(default)]
    system_vpn: Option<bool>,
}
fn passive_source() -> String {
    "passive".into()
}
fn one_sample() -> u32 {
    1
}
pub async fn telemetry(
    State(app): State<App>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let id = verify_device(&app, &headers, "/v1/telemetry", &body)?;
    let input: Telemetry = serde_json::from_slice(&body).map_err(|_| bad("Invalid telemetry"))?;
    commit_telemetry(&app, &id, input)
}
// Authentication is deliberately outside this operation. Privacy generation and
// command expiry are read again at the actual transaction, never cached by auth.
fn commit_telemetry(app: &App, id: &str, mut input: Telemetry) -> ApiResult<Json<Value>> {
    let photo_bytes = input
        .recovery_photo
        .as_ref()
        .map(|p| p.validate())
        .transpose()?;
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
            || !["passive", "homing", "haste", "best_guess"].contains(&l.source.as_str())
            || !(1..=120).contains(&l.samples)
        {
            return Err(bad("Invalid location values or timestamp"));
        }
    }
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    let (mut location, epoch): (Option<String>, String) = tx
        .query_row(
            "SELECT last_location,gps_epoch FROM devices WHERE id=? AND revoked=0",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(denied)?;
    let has_gps = input.location.is_some() || !input.locations.is_empty();
    if has_gps && input.gps_epoch.is_none() {
        return Err(Error(
            StatusCode::CONFLICT,
            "GPS generation required; update the phone app",
        ));
    }
    let gps_accepted = input.gps_epoch.as_deref() == Some(epoch.as_str());
    let accepted_photo = match (&input.recovery_photo, &photo_bytes) {
        (Some(photo), Some(bytes)) => {
            crate::photos::commit(&tx, id, input.photo_epoch.as_deref(), photo, bytes)?
        }
        _ => None,
    };
    let photo_epoch: String =
        tx.query_row("SELECT photo_epoch FROM devices WHERE id=?", [id], |r| {
            r.get(0)
        })?;
    if let Some(command) = &input.locate_command {
        let authorized: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM commands WHERE id=? AND device_id=? AND kind IN ('locate','best_guess') AND status='delivered' AND expires>?)",
            params![command,id,now()], |r| r.get(0))?;
        if !authorized || input.location.is_none() || !input.locations.is_empty() {
            return Err(Error(
                StatusCode::CONFLICT,
                "Locate expired, was not offered, or contains no single requested fix",
            ));
        }
    }
    let mut accepted_observations = Vec::new();
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
    for fix in fixes.into_iter().filter(|_| gps_accepted) {
        // Keep backfilled points in history without moving the last-known point backwards.
        tx.execute("INSERT OR IGNORE INTO location_history(device_id,observed_at,received_at,latitude,longitude,accuracy,source,samples,system_vpn) VALUES(?,?,?,?,?,?,?,?,?)",
            params![id,fix.observed_at,received,fix.latitude,fix.longitude,fix.accuracy,fix.source,fix.samples,fix.system_vpn])?;
        let matches: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM location_history WHERE device_id=? AND observed_at=? AND latitude=? AND longitude=? AND accuracy=?)",
            params![id,fix.observed_at,fix.latitude,fix.longitude,fix.accuracy], |r| r.get(0))?;
        if matches {
            accepted_observations.push(fix.observed_at);
        }
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
            serde_json::to_string(&input.capabilities.iter().filter(|kind|kind.as_str()!="dns_check").collect::<Vec<_>>()).unwrap(),
            id
        ],
    )?;
    // Locate expiry is a server commit-admission deadline, rechecked before commit.
    if let Some(command) = &input.locate_command {
        let live: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM commands WHERE id=? AND device_id=? AND expires>?)",
            params![command, id, now()],
            |r| r.get(0),
        )?;
        if !live {
            return Err(Error(StatusCode::CONFLICT, "Locate expired before commit"));
        }
    }
    tx.commit()?;
    Ok(Json(
        json!({"accepted":true,"gps_accepted":gps_accepted,"gps_epoch":epoch,"photo_epoch":photo_epoch,"accepted_photo":accepted_photo,"accepted_observations":accepted_observations,"server_time":now()}),
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
    let changed = tx.execute("UPDATE devices SET history_revision=history_revision+1,gps_epoch=?,
        location_floor=MAX(location_floor,COALESCE(json_extract(last_location,'$.observed_at'),0),?),
        last_location=NULL WHERE id=? AND revoked=0 AND public_key IS NOT NULL", params![token(),now(),id])?;
    if changed != 1 {
        return Err(Error(StatusCode::NOT_FOUND, "Enrolled device not found"));
    }
    tx.execute("DELETE FROM location_history WHERE device_id=?", [id])?;
    if include_state {
        crate::photos::erase_in(&tx, id)?;
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
    let tx = db.unchecked_transaction()?;
    if input.kind == "stop_all" {
        // Stop requests bypass a full queue and invalidate old offers in the same commit.
        tx.execute("UPDATE commands SET status='canceled',canceled_at=?,canceled_after_offer=(status='delivered'),result='Canceled by Stop all actions' WHERE device_id=? AND status IN ('pending','delivered')",params![now(),id])?;
        tx.execute("INSERT INTO device_policies(device_id,revision,policy) VALUES(?,1,?) ON CONFLICT(device_id) DO UPDATE SET revision=revision+1,policy=excluded.policy",params![id,serde_json::to_string(&crate::management::Policy::default()).unwrap()])?;
    }
    let pending:i64=tx.query_row("SELECT count(*) FROM commands WHERE device_id=? AND status IN ('pending','delivered') AND expires>?",params![id,now()],|r|r.get(0))?;
    if pending >= 10 {
        return Err(bad("Too many commands awaiting delivery"));
    }
    let cmd = uuid::Uuid::new_v4().to_string();
    let payload = json!({"message":text}).to_string();
    let expires = now() + if input.kind == "stop_all" { 86400 } else { 300 };
    tx.execute(
        "INSERT INTO commands(id,device_id,kind,payload,created,expires) VALUES(?,?,?,?,?,?)",
        params![cmd, id, input.kind, payload, now(), expires],
    )?;
    store::audit(&tx, "command.queued", Some(&id), &input.kind)?;
    tx.commit()?;
    Ok(Json(json!({"id":cmd,"status":"pending","expires":expires})))
}
pub async fn cancel_command(
    State(app): State<App>,
    headers: HeaderMap,
    Path((id, command)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    let row: Option<String> = tx
        .query_row(
            "SELECT status FROM commands WHERE id=? AND device_id=?",
            params![command, id],
            |r| r.get(0),
        )
        .optional()?;
    let status = row.ok_or(Error(StatusCode::NOT_FOUND, "Command not found"))?;
    if status == "canceled" {
        return Ok(Json(json!({"canceled":true})));
    }
    if !["pending", "delivered"].contains(&status.as_str()) {
        return Err(Error(StatusCode::CONFLICT, "This command already finished"));
    }
    let offered = status == "delivered";
    tx.execute("UPDATE commands SET status='canceled',canceled_at=?,canceled_after_offer=?,result=? WHERE id=? AND device_id=?",params![now(),offered,if offered {"Retries stopped; an already offered command may still complete"} else {"Canceled before delivery"},command,id])?;
    store::audit(
        &tx,
        "command.canceled",
        Some(&id),
        if offered {
            "Retries stopped after offer"
        } else {
            "Canceled before offer"
        },
    )?;
    tx.commit()?;
    Ok(Json(json!({"canceled":true,"already_offered":offered})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandCheck {
    id: String,
}
pub async fn check_command(
    State(app): State<App>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let id = verify_device(&app, &headers, "/v1/command-check", &body)?;
    let input: CommandCheck =
        serde_json::from_slice(&body).map_err(|_| bad("Invalid command check"))?;
    let db = app.db.lock().unwrap();
    let allowed: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM commands WHERE id=? AND device_id=? AND status='delivered' AND expires>?)",params![input.id,id,now()],|r|r.get(0))?;
    Ok(Json(json!({"allowed":allowed,"server_time":now()})))
}
pub async fn poll(
    State(app): State<App>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let id = verify_device(&app, &headers, "/v1/commands", &body)?;
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Poll {
        #[serde(default)]
        only_stop: bool,
    }
    let input: Poll = serde_json::from_slice(&body).map_err(|_| bad("Invalid command poll"))?;
    let db = app.db.lock().unwrap();
    db.execute("UPDATE commands SET status='rejected',result='Disabled by reversibility policy' WHERE device_id=? AND kind='reboot' AND status IN ('pending','delivered')", [&id])?;
    let mut q=db.prepare("SELECT id,kind,payload,expires FROM commands WHERE device_id=? AND status IN ('pending','delivered') AND expires>? AND (?=0 OR kind='stop_all') ORDER BY (kind='stop_all') DESC,created LIMIT 10")?;
    let list=q.query_map(params![id,now(),input.only_stop],|r|Ok(json!({"id":r.get::<_,String>(0)?,"kind":r.get::<_,String>(1)?,"payload":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(json!({})),"expires":r.get::<_,i64>(3)?})))?.collect::<Result<Vec<_>,_>>()?;
    for command in &list {
        db.execute("UPDATE commands SET status='delivered' WHERE id=? AND device_id=? AND status='pending'",params![command["id"].as_str(),id])?;
    }
    // Messages and command results are deleted after 24h; retain only bounded metadata in audit.
    db.execute("DELETE FROM commands WHERE created<?", [now() - 86400])?;
    let epoch: String = db.query_row(
        "SELECT gps_epoch FROM devices WHERE id=? AND revoked=0",
        [&id],
        |r| r.get(0),
    )?;
    Ok(Json(
        json!({"commands":list,"gps_epoch":epoch,"photo_epoch":db.query_row("SELECT photo_epoch FROM devices WHERE id=?",[&id],|r|r.get::<_,String>(0))?,"server_time":now()}),
    ))
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
            if status == "canceled" {
                // Settle the durable phone receipt, while preserving the cancellation.
                // Work already offered may have run; keep its actual result visible.
                db.execute("UPDATE commands SET receipt_received_at=?,result=? WHERE id=? AND device_id=? AND canceled_after_offer=1",params![received,format!("Canceled; phone later reported {}: {}",input.status,input.result),input.id,id])?;
                return Ok(Json(
                    json!({"accepted":false,"settled":true,"receipt_status":"canceled","server_time":received}),
                ));
            }
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
    tx.execute("DELETE FROM recovery_photos WHERE device_id=?", [&id])?;
    tx.execute("DELETE FROM erased_photos WHERE device_id=?", [&id])?;
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

#[cfg(test)]
mod privacy_tests {
    use super::*;
    use p256::{
        ecdsa::{SigningKey, signature::Signer},
        pkcs8::EncodePublicKey,
    };
    use std::sync::{Arc, Mutex};

    #[test]
    fn authenticated_before_erase_cannot_commit_old_generation_after_erase() {
        let directory =
            std::env::temp_dir().join(format!("bungee-auth-erase-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let db = store::open(&directory.join("bungee.sqlite3")).unwrap();
        let key = SigningKey::random(&mut rand::rngs::OsRng);
        let public = STANDARD.encode(key.verifying_key().to_public_key_der().unwrap().as_bytes());
        let epoch = token();
        db.execute("INSERT INTO devices(id,name,wg_key,address,created,public_key,gps_epoch) VALUES('phone','Phone','fixture','10.77.0.2',1,?,?)",params![public,epoch]).unwrap();
        let cookie = token();
        db.execute(
            "INSERT INTO sessions VALUES(?,?)",
            params![hash(&cookie), now() + 600],
        )
        .unwrap();
        let app = App {
            db: Arc::new(Mutex::new(db)),
            origin: String::new(),
            secure_cookie: false,
            admin_networks: vec!["127.0.0.0/8".parse().unwrap()],
            limiter: Arc::new(Mutex::new(RateLimits::default())),
            state_dir: directory.clone(),
            wg_endpoint: None,
            geography: Arc::new(crate::geography::Geography::load().unwrap()),
        };
        let body = json!({"battery":42,"charging":false,"capabilities":[],"device_owner":false,"gps_epoch":epoch,
            "location":{"latitude":1.0,"longitude":2.0,"accuracy":3.0,"observed_at":now()+60}}).to_string();
        let stamp = now().to_string();
        let nonce = token();
        let signature: p256::ecdsa::Signature = key.sign(
            format!(
                "BUNGEE-V1\nPOST\n/v1/telemetry\n{stamp}\n{nonce}\n{}",
                hash(&body)
            )
            .as_bytes(),
        );
        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("x-bungee-device", "phone".into()),
            ("x-bungee-time", stamp),
            ("x-bungee-nonce", nonce),
            (
                "x-bungee-signature",
                STANDARD.encode(signature.to_der().as_bytes()),
            ),
        ] {
            headers.insert(name, value.parse().unwrap());
        }
        let id = verify_device(&app, &headers, "/v1/telemetry", body.as_bytes()).unwrap();
        let input: Telemetry = serde_json::from_str(&body).unwrap();
        let mut admin = HeaderMap::new();
        admin.insert(
            "cookie",
            format!("bungee_session={cookie}").parse().unwrap(),
        );
        assert!(
            erase_history(&app, &admin, &id, false).unwrap().0["cleared"]
                .as_bool()
                .unwrap()
        );
        let result = commit_telemetry(&app, &id, input).unwrap().0;
        assert_eq!(result["gps_accepted"], false);
        let db = app.db.lock().unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM location_history", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(
            db.query_row(
                "SELECT last_location FROM devices WHERE id='phone'",
                [],
                |r| r.get::<_, Option<String>>(0)
            )
            .unwrap()
            .is_none()
        );
        drop(db);
        drop(app);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
