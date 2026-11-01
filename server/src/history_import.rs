use crate::{App, security::*, store};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{Value, json};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Import {
    records: Vec<Point>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Point {
    observed_at: i64,
    received_at: i64,
    latitude: f64,
    longitude: f64,
    accuracy: f64,
    source: String,
    samples: u32,
    system_vpn: Option<bool>,
}
pub async fn import(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<Import>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    if input.records.is_empty()
        || input.records.len() > 100
        || input.records.iter().any(|p| {
            p.observed_at <= 0
                || p.observed_at > now() + 120
                || p.received_at <= 0
                || p.received_at > now() + 120
                || !p.latitude.is_finite()
                || !(-90.0..=90.0).contains(&p.latitude)
                || !p.longitude.is_finite()
                || !(-180.0..=180.0).contains(&p.longitude)
                || !p.accuracy.is_finite()
                || !(0.0..=100000.0).contains(&p.accuracy)
                || !(1..=1000).contains(&p.samples)
                || !["passive", "homing", "haste", "best_guess"].contains(&p.source.as_str())
        })
    {
        return Err(bad(
            "Import 1–100 valid GPS rows with original times, accuracy and collection source",
        ));
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(app.state_dir.as_os_str().as_bytes())
            .map_err(|_| bad("Invalid storage path"))?;
        let mut info = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        // SAFETY: valid C string and writable statvfs buffer.
        if unsafe { libc::statvfs(path.as_ptr(), info.as_mut_ptr()) } != 0 {
            return Err(Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Cannot check history storage",
            ));
        }
        // SAFETY: statvfs succeeded above.
        let info = unsafe { info.assume_init() };
        if (info.f_bavail as u128) * (info.f_frsize as u128) < 256 * 1024 * 1024 {
            return Err(Error(
                StatusCode::INSUFFICIENT_STORAGE,
                "Free at least 256 MiB before restoring history",
            ));
        }
    }
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM devices WHERE id=?)",
        [&id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(Error(StatusCode::NOT_FOUND, "Saved device not found"));
    }
    let mut added = 0;
    for p in &input.records {
        added+=tx.execute("INSERT OR IGNORE INTO location_history(device_id,observed_at,received_at,latitude,longitude,accuracy,source,samples,system_vpn,imported_at) VALUES(?,?,?,?,?,?,?,?,?,?)",params![id,p.observed_at,p.received_at,p.latitude,p.longitude,p.accuracy,p.source,p.samples,p.system_vpn,now()])?;
    }
    if added > 0 {
        tx.execute("UPDATE devices SET last_location=(SELECT json_object('latitude',latitude,'longitude',longitude,'accuracy',accuracy,'observed_at',observed_at,'source',source,'samples',samples,'system_vpn',json(CASE system_vpn WHEN 1 THEN 'true' WHEN 0 THEN 'false' ELSE 'null' END),'imported_at',imported_at) FROM location_history WHERE device_id=? ORDER BY observed_at DESC LIMIT 1),history_revision=history_revision+1 WHERE id=?",params![id,id])?;
        store::audit(
            &tx,
            "history.imported",
            Some(&id),
            &format!("{added} saved GPS rows restored from CSV; existing rows unchanged"),
        )?;
    }
    tx.commit()?;
    Ok(Json(
        json!({"added":added,"skipped":input.records.len()-added}),
    ))
}
