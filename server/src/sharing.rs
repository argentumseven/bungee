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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    detail: Option<Detail>,
}

/// Circumstances the phone could observe when a device-state event happened.
/// Only fixed flags and counters are accepted: never coordinates, network names
/// or free text. An omitted field means the phone could not tell.
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Detail {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub airplane: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location_services: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gps_provider: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fine_location: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_location: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interactive: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sharing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suppressed: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failures: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minutes: Option<u32>,
}
impl Detail {
    fn valid(&self, at: i64) -> bool {
        self.source
            .as_deref()
            .is_none_or(|v| ["live", "reconciled"].contains(&v))
            && self.since.is_none_or(|v| v > 0 && v <= at + 120)
            && self.network.as_deref().is_none_or(|v| {
                ["none", "wifi", "cellular", "ethernet", "vpn", "other"].contains(&v)
            })
            && self.suppressed.is_none_or(|v| v <= 1_000_000)
            && self.failures.is_none_or(|v| v <= 1_000_000)
            && self.minutes.is_none_or(|v| v <= 5_256_000)
    }
    fn reconciled(&self) -> bool {
        self.source.as_deref() == Some("reconciled")
    }
}
/// Reasons reported by the phone's device-state monitor rather than by a sharing start/stop.
pub const DEVICE_STATE: &[&str] = &[
    "airplane_mode_on",
    "airplane_mode_off",
    "location_services_off",
    "location_services_on",
    "gps_provider_off",
    "gps_provider_on",
    "location_permission_lost",
    "location_permission_restored",
    "background_location_lost",
    "background_location_restored",
    "gps_no_fix",
    "gps_fix_restored",
];
pub fn device_state(code: &str) -> bool {
    DEVICE_STATE.contains(&code)
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
        "airplane_mode_on" => (
            "airplane_on",
            "system",
            "Airplane mode turned on; Android does not report who or what changed it",
        ),
        "airplane_mode_off" => (
            "airplane_off",
            "system",
            "Airplane mode turned off; Android does not report who or what changed it",
        ),
        "location_services_off" => (
            "location_off",
            "system",
            "Android location services turned off; GPS cannot be collected",
        ),
        "location_services_on" => (
            "location_on",
            "system",
            "Android location services turned back on",
        ),
        "gps_provider_off" => (
            "location_off",
            "system",
            "Android's GPS provider was disabled while location services stayed on",
        ),
        "gps_provider_on" => (
            "location_on",
            "system",
            "Android's GPS provider was enabled again",
        ),
        "location_permission_lost" => (
            "permission_lost",
            "system",
            "Precise location permission was removed from Bungee",
        ),
        "location_permission_restored" => (
            "permission_restored",
            "system",
            "Precise location permission was granted to Bungee again",
        ),
        "background_location_lost" => (
            "permission_lost",
            "system",
            "Background location permission was removed; automatic GPS restart is limited",
        ),
        "background_location_restored" => (
            "permission_restored",
            "system",
            "Background location permission was granted again",
        ),
        "gps_no_fix" => (
            "gps_gap",
            "system",
            "No usable GPS fix for several minutes although location services were available",
        ),
        "gps_fix_restored" => ("gps_gap_ended", "system", "Usable GPS fixes resumed"),
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
                && e.detail.as_ref().is_none_or(|d| {
                    device_state(&e.reason) && d.valid(e.recorded_at.max(e.at.unwrap_or(0)))
                })
                && match e.at {
                    Some(at) => at > 0 && at <= now() + 120,
                    // A change found after the app was not running has no trustworthy time.
                    None => {
                        e.reason == "unexpected_exit"
                            || (device_state(&e.reason)
                                && e.detail.as_ref().is_some_and(Detail::reconciled))
                    }
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
    // An administrator's age purge sets this floor. Older events still waiting on a
    // phone are acknowledged so the phone drops them, but they are not stored again.
    let floor: i64 = tx.query_row("SELECT activity_floor FROM devices WHERE id=?", [id], |r| {
        r.get(0)
    })?;
    let mut accepted = Vec::new();
    for e in events {
        let detail = e
            .detail
            .as_ref()
            .map(|d| serde_json::to_string(d).unwrap_or_default());
        let existing: Option<(String, Option<i64>, i64, Option<String>)> = tx
            .query_row(
                "SELECT reason,at,recorded_at,detail FROM sharing_events WHERE device_id=? AND event_id=?",
                params![id, e.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        if let Some(content) = existing {
            if content != (e.reason.clone(), e.at, e.recorded_at, detail) {
                return Err(Error(
                    StatusCode::CONFLICT,
                    "Sharing event ID already has different content",
                ));
            }
        } else if e.at.unwrap_or(e.recorded_at) >= floor {
            tx.execute("INSERT INTO sharing_events(device_id,event_id,reason,at,recorded_at,received_at,detail) VALUES(?,?,?,?,?,?,?)",params![id,e.id,e.reason,e.at,e.recorded_at,now(),detail])?;
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
    from: Option<i64>,
    to: Option<i64>,
}

pub async fn history(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(page): Query<Page>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let (from, to) = crate::activity::date_bounds(page.from, page.to)?;
    let before = page.before.unwrap_or(i64::MAX);
    if before <= 0 {
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
    let mut q = db.prepare("SELECT e.sequence,e.event_id,e.reason,e.at,e.recorded_at,e.received_at,d.id,d.name,d.primary_device_id,e.detail FROM sharing_events e JOIN devices d ON d.id=e.device_id WHERE (d.id=? OR d.primary_device_id=?) AND e.sequence<? AND COALESCE(e.at,e.recorded_at) BETWEEN ? AND ? ORDER BY e.sequence DESC LIMIT 21")?;
    let mut rows = q.query_map(params![id,id,before,from,to], |r| {
        let code: String = r.get(2)?;
        let (kind, category, label) = reason(&code).unwrap_or(("unknown","unknown","Unrecognized sharing event"));
        Ok(json!({"sequence":r.get::<_,i64>(0)?,"id":r.get::<_,String>(1)?,"reason":code,"kind":kind,"category":category,"label":label,"at":r.get::<_,Option<i64>>(3)?,"recorded_at":r.get::<_,i64>(4)?,"received_at":r.get::<_,i64>(5)?,"device_id":r.get::<_,String>(6)?,"profile_name":if r.get::<_,Option<String>>(8)?.is_some(){r.get::<_,Option<String>>(7)?}else{None},"detail":r.get::<_,Option<String>>(9)?.and_then(|text|serde_json::from_str::<Value>(&text).ok())}))
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
