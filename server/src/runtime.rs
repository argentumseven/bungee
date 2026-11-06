//! A signing identity has one live process. Leases fence requests after a handoff;
//! they are not hardware attestation and do not choose between different profiles.
use crate::{App, security::*};
use axum::{
    Json,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
pub const TTL: i64 = 120;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Acquire {
    instance: String,
    secret: String,
    #[serde(default)]
    previous: Vec<String>,
    profile_fingerprint: Option<String>,
}
pub fn fingerprint(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn secret(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
pub async fn acquire(
    State(app): State<App>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let id = verify_device(&app, &headers, "/v1/runtime", &body)?;
    let input: Acquire =
        serde_json::from_slice(&body).map_err(|_| bad("Invalid runtime registration"))?;
    if uuid::Uuid::parse_str(&input.instance).is_err()
        || !secret(&input.secret)
        || input.previous.len() > 2
        || input.previous.iter().any(|s| !secret(s))
    {
        return Err(bad("Invalid runtime identity"));
    }
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    let expected: Option<String> = tx.query_row(
        "SELECT profile_fingerprint FROM devices WHERE id=?",
        [&id],
        |r| r.get(0),
    )?;
    if expected
        .as_ref()
        .is_some_and(|f| input.profile_fingerprint.as_ref() != Some(f))
    {
        return Err(Error(
            StatusCode::CONFLICT,
            "This pairing belongs to another Android profile. Reconnect its saved record",
        ));
    }
    let current: Option<(String, String, i64, i64)> = tx
        .query_row(
            "SELECT instance,secret_hash,generation,expires FROM device_runtimes WHERE device_id=?",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let digest = hash(&input.secret);
    let same = current
        .as_ref()
        .is_some_and(|c| c.0 == input.instance && c.1 == digest);
    let transferable = current
        .as_ref()
        .is_none_or(|c| c.3 <= now() || input.previous.iter().any(|s| hash(s) == c.1));
    if !same && !transferable {
        tx.execute("UPDATE device_runtimes SET conflict_at=?,conflicts=MIN(conflicts+1,1000000) WHERE device_id=?",params![now(),id])?;
        tx.commit()?;
        return Err(Error(
            StatusCode::LOCKED,
            "Another instance of this profile is connected. Stop the duplicate or reconnect this saved profile",
        ));
    }
    let generation = current.as_ref().map_or(1, |c| c.2 + i64::from(!same));
    tx.execute("INSERT INTO device_runtimes(device_id,instance,secret_hash,generation,expires) VALUES(?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET instance=excluded.instance,secret_hash=excluded.secret_hash,generation=excluded.generation,expires=excluded.expires,report_sequence=CASE WHEN device_runtimes.generation=excluded.generation THEN device_runtimes.report_sequence ELSE 0 END",params![id,input.instance,digest,generation,now()+TTL])?;
    tx.execute(
        "UPDATE devices SET runtime_required=1,last_contact=? WHERE id=?",
        params![now(), id],
    )?;
    tx.commit()?;
    Ok(Json(
        json!({"generation":generation,"expires":now()+TTL,"server_time":now()}),
    ))
}
/// Call under the same database lock/transaction as each mutation. A request
/// verified before another process took over cannot subsequently change state.
pub fn fence(db: &Connection, id: &str, headers: &HeaderMap) -> ApiResult<()> {
    let required: bool = db
        .query_row(
            "SELECT runtime_required FROM devices WHERE id=? AND revoked=0",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(denied)?;
    let instance = headers
        .get("x-bungee-instance")
        .and_then(|h| h.to_str().ok());
    let token = headers
        .get("x-bungee-runtime")
        .and_then(|h| h.to_str().ok());
    if !required && instance.is_none() && token.is_none() {
        return Ok(());
    }
    let (Some(instance), Some(token)) = (instance, token) else {
        return Err(Error(
            StatusCode::PRECONDITION_REQUIRED,
            "Register this app instance before continuing",
        ));
    };
    let valid: bool=db.query_row("SELECT EXISTS(SELECT 1 FROM device_runtimes WHERE device_id=? AND instance=? AND secret_hash=? AND expires>?)",params![id,instance,hash(token),now()],|r|r.get(0))?;
    if !valid {
        return Err(Error(
            StatusCode::PRECONDITION_REQUIRED,
            "This app instance no longer holds the connection. Register it again",
        ));
    }
    Ok(())
}
