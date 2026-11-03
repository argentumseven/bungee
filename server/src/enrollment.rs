use crate::{App, security::*, store};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rand::RngCore;
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

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
struct PeerUpdate {
    directory: PathBuf,
    temporary: PathBuf,
}
impl PeerUpdate {
    fn publish(self) -> ApiResult<()> {
        fs::rename(&self.temporary, self.directory.join("peers.conf"))?;
        fs::File::open(&self.directory)?.sync_all()?;
        Ok(())
    }
}
impl Drop for PeerUpdate {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.temporary);
    }
}
fn prepare_peers(app: &App, db: &rusqlite::Connection) -> ApiResult<PeerUpdate> {
    let dir = app.state_dir.join("wireguard");
    fs::create_dir_all(&dir)?;
    private_dir(&dir)?;
    // The database lock serializes the sole server writer. Any old staging file
    // here was abandoned by a previous process; it is never authoritative state.
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let staged = name == "peers.next"
            || name
                .strip_prefix(".peers-")
                .and_then(|v| v.strip_suffix(".next"))
                .is_some_and(|v| uuid::Uuid::parse_str(v).is_ok());
        if staged && !entry.file_type()?.is_dir() {
            fs::remove_file(entry.path())?;
        }
    }
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
    let update = PeerUpdate {
        temporary: dir.join(format!(".peers-{}.next", uuid::Uuid::new_v4())),
        directory: dir,
    };
    private_write(&update.temporary, text.as_bytes())?;
    Ok(update)
}
pub fn sync_peers(app: &App, db: &rusqlite::Connection) -> ApiResult<()> {
    prepare_peers(app, db)?.publish()
}

pub fn housekeeping(app: &App) -> ApiResult<()> {
    let db = app.db.lock().unwrap();
    db.execute("DELETE FROM commands WHERE created<?", [now() - 86400])?;
    db.execute("DELETE FROM sessions WHERE expires<?", [now()])?;
    db.execute("DELETE FROM enrollments WHERE expires<=?", [now()])?;
    sync_peers(app, &db)?;
    Ok(())
}
pub async fn create_enrollment(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Enrollment>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    issue(&app, input, prepare_peers)
}

/// Only explicit revocation or an expired, never-redeemed invitation is disposable.
/// An offline paired phone is still paired and must never be inferred abandoned.
pub async fn purge_binding(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    let eligible: Option<bool> = tx.query_row(
        "SELECT revoked=1 OR (public_key IS NULL AND NOT EXISTS(SELECT 1 FROM enrollments e WHERE e.device_id=devices.id AND e.expires>?)) FROM devices WHERE id=?",
        params![now(),id], |row| row.get(0)).optional()?;
    if eligible == Some(false) {
        return Err(Error(
            StatusCode::CONFLICT,
            "This binding is still in use. Revoke a paired phone or cancel its invitation before purging",
        ));
    }
    if eligible.is_some() {
        retire_binding(&tx, &id)?;
        store::audit(
            &tx,
            "device.binding_purged",
            Some(&id),
            "Connection keys released; saved history retained",
        )?;
    }
    let peers = prepare_peers(&app, &tx)?;
    tx.commit()?;
    // Retrying a completed purge also repairs a failed post-commit publication.
    peers.publish().map_err(|e| {
        tracing::error!(error=%e.1, "Binding purge committed but peer publication failed");
        Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Binding removed, but gateway refresh failed. Retry purge after fixing server storage",
        )
    })?;
    Ok(Json(json!({"purged":true,"history_retained":true})))
}
/// Releasing an authentication binding never removes recovery evidence.
fn retire_binding(db: &rusqlite::Connection, id: &str) -> ApiResult<()> {
    for table in ["enrollments", "nonces", "commands", "device_policies"] {
        db.execute(&format!("DELETE FROM {table} WHERE device_id=?"), [id])?;
    }
    db.execute("UPDATE devices SET revoked=1,public_key=NULL,wg_psk=NULL,wg_key=?,address=?,binding_released=1,management_report=NULL,capabilities='[]',history_revision=history_revision+1,gps_epoch=?,photo_epoch=? WHERE id=?",params![format!("released:{id}"),format!("retired:{id}"),token(),token(),id])?;
    Ok(())
}
pub async fn disconnect(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM devices WHERE id=?)",
        [&id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(Error(StatusCode::NOT_FOUND, "Device not found"));
    }
    retire_binding(&tx, &id)?;
    let peers = prepare_peers(&app, &tx)?;
    store::audit(
        &tx,
        "device.disconnected",
        Some(&id),
        "Connection disabled; all saved history retained",
    )?;
    tx.commit()?;
    peers.publish()?;
    Ok(Json(json!({"disconnected":true,"history_retained":true})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reconnect {
    wg_public_key: String,
}
pub async fn reconnect(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<Reconnect>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let name = app
        .db
        .lock()
        .unwrap()
        .query_row("SELECT name FROM devices WHERE id=?", [&id], |r| {
            r.get::<_, String>(0)
        })
        .optional()?
        .ok_or(Error(StatusCode::NOT_FOUND, "Saved device not found"))?;
    issue_for(
        &app,
        Enrollment {
            name,
            wg_public_key: input.wg_public_key,
        },
        Some(&id),
        prepare_peers,
    )
}
pub async fn delete_archive(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    let eligible: Option<bool> = tx
        .query_row(
            "SELECT revoked=1 AND binding_released=1 FROM devices WHERE id=?",
            [&id],
            |r| r.get(0),
        )
        .optional()?;
    if eligible != Some(true) {
        return Err(Error(
            StatusCode::CONFLICT,
            "Disconnect the phone before deleting its saved archive",
        ));
    }
    for table in [
        "enrollments",
        "nonces",
        "commands",
        "location_history",
        "state_history",
        "network_history",
        "recovery_photos",
        "erased_photos",
        "dns_summary",
        "device_policies",
    ] {
        tx.execute(&format!("DELETE FROM {table} WHERE device_id=?"), [&id])?;
    }
    tx.execute("DELETE FROM devices WHERE id=?", [&id])?;
    store::audit(
        &tx,
        "device.archive_erased",
        Some(&id),
        "Saved device and history explicitly erased",
    )?;
    tx.commit()?;
    Ok(Json(json!({"erased":true})))
}

fn issue(
    app: &App,
    input: Enrollment,
    prepare: fn(&App, &rusqlite::Connection) -> ApiResult<PeerUpdate>,
) -> ApiResult<Json<Value>> {
    issue_for(app, input, None, prepare)
}
fn issue_for(
    app: &App,
    input: Enrollment,
    replace: Option<&str>,
    prepare: fn(&App, &rusqlite::Connection) -> ApiResult<PeerUpdate>,
) -> ApiResult<Json<Value>> {
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
    let code = token();
    let mut psk = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut psk);
    let psk = STANDARD.encode(psk);
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    if let Some(target) = replace {
        let old: Option<String> = tx
            .query_row("SELECT name FROM devices WHERE id=?", [target], |r| {
                r.get(0)
            })
            .optional()?;
        if old.is_none() {
            return Err(Error(StatusCode::NOT_FOUND, "Saved device not found"));
        }
        let bound: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM devices WHERE wg_key=? AND id<>?)",
            params![input.wg_public_key, target],
            |r| r.get(0),
        )?;
        if bound {
            return Err(Error(
                StatusCode::CONFLICT,
                "This phone key belongs to another saved device",
            ));
        }
        let used = tx
            .prepare("SELECT address FROM devices WHERE id<>?")?
            .query_map([target], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let address = (2..=254)
            .map(|n| format!("10.77.0.{n}"))
            .find(|ip| !used.contains(ip))
            .ok_or_else(|| bad("Household device limit reached"))?;
        retire_binding(&tx, target)?;
        tx.execute("UPDATE devices SET name=?,wg_key=?,address=?,wg_psk=?,revoked=0,binding_released=0,last_contact=NULL,last_seen=NULL WHERE id=?",params![input.name.trim(),input.wg_public_key,address,psk,target])?;
        tx.execute(
            "INSERT INTO enrollments(hash,device_id,expires) VALUES(?,?,?)",
            params![hash(&code), target, now() + 600],
        )?;
        store::audit(
            &tx,
            "device.reconnected",
            Some(target),
            "New invitation; saved GPS/history retained",
        )?;
        let peers = prepare(app, &tx)?;
        tx.commit()?;
        peers.publish()?;
        return Ok(Json(
            json!({"version":2,"device_id":target,"name":input.name.trim(),"token":code,"expires":now()+600,"history_retained":true,
          "wireguard":{"endpoint":endpoint,"server_public_key":key.trim(),"client_public_key":input.wg_public_key,"preshared_key":psk,"address":format!("{address}/32"),"allowed_ip":"10.77.0.1/32"},"api_url":"http://10.77.0.1:8081"}),
        ));
    }
    let existing: Option<(String, String, bool)> = tx
        .query_row(
            "SELECT id,address,public_key IS NOT NULL FROM devices WHERE wg_key=?",
            [&input.wg_public_key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let reissued = existing.is_some();
    let (id, address) = match existing {
        Some((_, _, true)) => {
            return Err(bad(
                "This phone key is already bound. Use Reconnect on its saved device record to replace its connection and keep history",
            ));
        }
        Some((id, address, false)) => {
            // Never-enrolled pending/expired/revoked invitations can be explicitly
            // reissued. Rotate both secrets; a paired identity is never rebound.
            tx.execute("DELETE FROM enrollments WHERE device_id=?", [&id])?;
            tx.execute("UPDATE devices SET name=?,revoked=0,wg_psk=?,created=? WHERE id=? AND public_key IS NULL", params![input.name.trim(),psk,now(),id])?;
            (id, address)
        }
        None => {
            let used = tx
                .prepare("SELECT address FROM devices")?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            let address = if let Some(address) = (2..=254)
                .map(|n| format!("10.77.0.{n}"))
                .find(|ip| !used.contains(ip))
            {
                address
            } else {
                let expired: Option<(String,String)> = tx.query_row("SELECT id,address FROM devices WHERE binding_released=0 AND (revoked=1 OR (public_key IS NULL AND NOT EXISTS(SELECT 1 FROM enrollments e WHERE e.device_id=devices.id AND e.expires>?))) ORDER BY created LIMIT 1", [now()], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
                let (old, address) =
                    expired.ok_or_else(|| bad("Household device limit reached"))?;
                retire_binding(&tx, &old)?;
                store::audit(
                    &tx,
                    "enrollment.reclaimed",
                    Some(&old),
                    "Inactive address reclaimed; saved history retained",
                )?;
                address
            };
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute(
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
            (id, address)
        }
    };
    let expires = now() + 600;
    tx.execute(
        "INSERT INTO enrollments(hash,device_id,expires) VALUES(?,?,?)",
        params![hash(&code), id, expires],
    )?;
    store::audit(
        &tx,
        if reissued {
            "enrollment.reissued"
        } else {
            "enrollment.created"
        },
        Some(&id),
        "Expires in 10 minutes",
    )?;
    // Validate and fsync the derived file before committing any database change.
    // Publish only committed state. A post-commit publish failure remains safely
    // reissuable; housekeeping regenerates peers from the canonical database.
    let peers = prepare(app, &tx)?;
    tx.commit()?;
    peers.publish().map_err(|e| {
        tracing::error!(error=%e.1, "Invitation committed but peer publication failed; explicit reissue is safe");
        Error(StatusCode::SERVICE_UNAVAILABLE, "Gateway update failed; retry this invitation with the same phone key after fixing server storage")
    })?;
    Ok(Json(
        json!({"version":2,"device_id":id,"name":input.name.trim(),"token":code,"expires":expires,
      "wireguard":{"endpoint":endpoint,"server_public_key":key.trim(),"client_public_key":input.wg_public_key,"preshared_key":psk,"address":format!("{address}/32"),"allowed_ip":"10.77.0.1/32"},
      "api_url":"http://10.77.0.1:8081"}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    fn fail_create(_: &App, _: &rusqlite::Connection) -> ApiResult<PeerUpdate> {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Injected temporary-file creation failure",
        )
        .into())
    }
    fn fail_after_write(app: &App, db: &rusqlite::Connection) -> ApiResult<PeerUpdate> {
        let _staged = prepare_peers(app, db)?;
        Err(std::io::Error::other("Injected failure after temporary-file fsync").into())
    }
    fn fail_commit(app: &App, db: &rusqlite::Connection) -> ApiResult<PeerUpdate> {
        db.execute_batch("PRAGMA defer_foreign_keys=ON; INSERT INTO enrollments(hash,device_id,expires) VALUES('injected-orphan','missing-device',1)")?;
        prepare_peers(app, db)
    }
    #[test]
    fn staging_failures_roll_back_state_and_remove_temporary_secrets() {
        let directory =
            std::env::temp_dir().join(format!("bungee-enrollment-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(directory.join("wireguard")).unwrap();
        fs::write(
            directory.join("wireguard/server-public-key"),
            STANDARD.encode([7u8; 32]),
        )
        .unwrap();
        fs::write(
            directory.join("wireguard/peers.conf"),
            b"original peer state",
        )
        .unwrap();
        let app = App {
            db: Arc::new(Mutex::new(
                store::open(&directory.join("bungee.sqlite3")).unwrap(),
            )),
            origin: "http://127.0.0.1:8080".into(),
            secure_cookie: false,
            admin_networks: vec!["127.0.0.0/8".parse().unwrap()],
            limiter: Arc::new(Mutex::new(RateLimits::default())),
            state_dir: directory.clone(),
            wg_endpoint: Some("203.0.113.10:47937".into()),
            dns: None,
            private_dns: None,
            geography: Arc::new(crate::geography::Geography::load().unwrap()),
        };
        for prepare in [
            fail_create as fn(&App, &rusqlite::Connection) -> ApiResult<PeerUpdate>,
            fail_after_write,
            fail_commit,
        ] {
            let input = Enrollment {
                name: "Storage failure test".into(),
                wg_public_key: STANDARD.encode([8u8; 32]),
            };
            assert!(issue(&app, input, prepare).is_err());
            let db = app.db.lock().unwrap();
            assert_eq!(
                db.query_row("SELECT count(*) FROM devices", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(
                db.query_row("SELECT count(*) FROM enrollments", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(
                db.query_row("SELECT count(*) FROM audit", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(
                fs::read(directory.join("wireguard/peers.conf")).unwrap(),
                b"original peer state"
            );
            assert_eq!(
                fs::read_dir(directory.join("wireguard")).unwrap().count(),
                2
            );
        }
        // A process crash bypasses Drop. Later synchronization removes only
        // recognized staging names before creating a new private temporary file.
        let abandoned = directory.join(format!("wireguard/.peers-{}.next", uuid::Uuid::new_v4()));
        fs::write(&abandoned, b"abandoned private peer state").unwrap();
        fs::write(
            directory.join("wireguard/peers.next"),
            b"legacy abandoned state",
        )
        .unwrap();
        {
            let db = app.db.lock().unwrap();
            let staged = prepare_peers(&app, &db).unwrap();
            assert!(!abandoned.exists());
            assert!(!directory.join("wireguard/peers.next").exists());
            drop(staged);
            assert_eq!(
                fs::read_dir(directory.join("wireguard")).unwrap().count(),
                2
            );
        }
        drop(app);
        fs::remove_dir_all(directory).unwrap();
    }
}
