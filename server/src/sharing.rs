use crate::{App, security::*};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    id: String,
    reason: String,
    at: Option<i64>,
    recorded_at: i64,
}
pub fn reason(code: &str) -> Option<(&'static str, &'static str, &'static str)> {
    Some(match code {
        "user_start" => ("started", "manual", "Started manually in Bungee"),
        "automatic_start" => (
            "started",
            "automatic",
            "Started through approved automatic recovery",
        ),
        "system_restart" => ("started", "system", "Android restarted the sharing service"),
        "user_stop" => ("stopped", "manual", "Stopped manually in Bungee"),
        "notification_stop" => (
            "stopped",
            "manual",
            "Stopped using the sharing notification",
        ),
        "local_recovery" => ("stopped", "manual", "Stopped through local recovery"),
        "gps_on" => (
            "gps_enabled",
            "manual",
            "Automatic GPS sharing enabled manually",
        ),
        "gps_off" => (
            "gps_disabled",
            "manual",
            "Automatic GPS sharing disabled manually",
        ),
        "consent_storage_error" => (
            "stopped",
            "error",
            "Stopped after a consent/settings storage error",
        ),
        "start_restricted" => (
            "error",
            "error",
            "Android refused to start the sharing service",
        ),
        "management_blocked" => (
            "stopped",
            "error",
            "Stopped because Android management blocked operation",
        ),
        "pairing_unavailable" => (
            "stopped",
            "error",
            "Stopped because pairing was unavailable",
        ),
        "worker_error" => (
            "stopped",
            "error",
            "Stopped after an unexpected sharing-service error",
        ),
        "service_ended" => (
            "stopped",
            "unknown",
            "Sharing service ended; Android supplied no reason",
        ),
        "crash" => ("stopped", "crash", "Android reported an app crash"),
        "native_crash" => ("stopped", "crash", "Android reported a native app crash"),
        "anr" => (
            "stopped",
            "error",
            "Android reported that the app stopped responding",
        ),
        "low_memory" => (
            "stopped",
            "system",
            "Android stopped the app because memory was low",
        ),
        "android_user_stopped" => (
            "stopped",
            "manual",
            "Android reported a user-requested app stop",
        ),
        "permission_change" => (
            "stopped",
            "system",
            "Android ended the app after a permission change",
        ),
        "package_changed" => (
            "stopped",
            "system",
            "Android ended the app during a package change",
        ),
        "system_killed" => ("stopped", "system", "Android ended the app process"),
        "android_exit_unknown" => (
            "stopped",
            "unknown",
            "Android reported a process exit with an unknown cause",
        ),
        "locate_start" => (
            "locate_started",
            "manual",
            "Temporary GPS requested through recovery commands",
        ),
        "locate_finished" => (
            "locate_finished",
            "automatic",
            "Temporary GPS request completed",
        ),
        "locate_error" => (
            "error",
            "error",
            "Temporary GPS request failed or was canceled",
        ),
        "unexpected_exit" => (
            "stopped",
            "unknown",
            "Previous sharing session ended; cause and stop time unknown",
        ),
        _ => return None,
    })
}
pub fn valid(events: &[Event]) -> bool {
    events.len() <= 20
        && events.iter().all(|e| {
            e.id.len() == 36
                && uuid::Uuid::parse_str(&e.id).is_ok()
                && reason(&e.reason).is_some()
                && e.recorded_at > 0
                && e.recorded_at <= now() + 120
                && match e.at {
                    Some(at) => at > 0 && at <= now() + 120,
                    None => e.reason == "unexpected_exit",
                }
        })
}
pub fn epoch(db: &Connection, id: &str) -> rusqlite::Result<String> {
    db.query_row("SELECT sharing_epoch FROM devices WHERE id=?", [id], |r| {
        r.get(0)
    })
}
pub fn commit(
    db: &Connection,
    id: &str,
    offered_epoch: Option<&str>,
    events: &[Event],
) -> ApiResult<Vec<String>> {
    if events.is_empty() || offered_epoch != Some(epoch(db, id)?.as_str()) {
        return Ok(vec![]);
    }
    let tx = db.unchecked_transaction()?;
    let mut accepted = Vec::new();
    for e in events {
        let existing: Option<(String, Option<i64>, i64)> = tx
            .query_row(
                "SELECT reason,at,recorded_at FROM sharing_events WHERE device_id=? AND event_id=?",
                params![id, e.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some(content) = existing {
            if content != (e.reason.clone(), e.at, e.recorded_at) {
                return Err(Error(
                    StatusCode::CONFLICT,
                    "Sharing event ID already has different content",
                ));
            }
        } else {
            tx.execute("INSERT INTO sharing_events(device_id,event_id,reason,at,recorded_at,received_at) VALUES(?,?,?,?,?,?)",params![id,e.id,e.reason,e.at,e.recorded_at,now()])?;
        }
        accepted.push(e.id.clone());
    }
    tx.commit()?;
    Ok(accepted)
}
pub fn erase(db: &Connection, id: &str) -> rusqlite::Result<()> {
    for member in crate::profiles::members(db, id)? {
        db.execute("DELETE FROM sharing_events WHERE device_id=?", [&member])?;
        db.execute(
            "UPDATE devices SET sharing_epoch=? WHERE id=?",
            params![token(), member],
        )?;
    }
    Ok(())
}
#[derive(Deserialize)]
pub struct Page {
    before: Option<i64>,
}
pub async fn history(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(page): Query<Page>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    if page.before.is_some_and(|n| n <= 0) {
        return Err(bad("Invalid sharing history cursor"));
    }
    let db = app.db.lock().unwrap();
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM devices WHERE id=?)",
        [&id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(Error(StatusCode::NOT_FOUND, "Device not found"));
    }
    let mut q = db.prepare("SELECT e.sequence,e.event_id,e.reason,e.at,e.recorded_at,e.received_at,d.id,d.name,d.primary_device_id FROM sharing_events e JOIN devices d ON d.id=e.device_id WHERE (d.id=? OR d.primary_device_id=?) AND e.sequence<? ORDER BY e.sequence DESC LIMIT 21")?;
    let mut rows = q.query_map(params![id,id,page.before.unwrap_or(i64::MAX)], |r| {
        let code: String = r.get(2)?;
        let (kind, category, label) = reason(&code).unwrap_or(("unknown","unknown","Unrecognized sharing event"));
        Ok(json!({"sequence":r.get::<_,i64>(0)?,"id":r.get::<_,String>(1)?,"reason":code,"kind":kind,"category":category,"label":label,"at":r.get::<_,Option<i64>>(3)?,"recorded_at":r.get::<_,i64>(4)?,"received_at":r.get::<_,i64>(5)?,"device_id":r.get::<_,String>(6)?,"profile_name":if r.get::<_,Option<String>>(8)?.is_some(){r.get::<_,Option<String>>(7)?}else{None}}))
    })?.collect::<Result<Vec<_>,_>>()?;
    let more = rows.len() > 20;
    rows.truncate(20);
    let next = if more {
        rows.last().and_then(|e| e["sequence"].as_i64())
    } else {
        None
    };
    let dropped: i64 = db.query_row("SELECT COALESCE(SUM(COALESCE(json_extract(management_report,'$.sharing_events_dropped'),0)),0) FROM devices WHERE id=? OR primary_device_id=?", params![id,id], |r| r.get(0))?;
    Ok(Json(
        json!({"events":rows,"next_before":next,"dropped":dropped}),
    ))
}
