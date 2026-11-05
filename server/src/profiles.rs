use crate::security::*;
use axum::http::StatusCode;
use rusqlite::Connection;
use serde_json::Value;

pub const COMMANDS: &[&str] = &["message", "clear_message", "stop_all"];

pub fn companion(db: &Connection, id: &str) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM devices WHERE id=? AND primary_device_id IS NOT NULL)",
        [id],
        |r| r.get(0),
    )
}

pub fn require_primary(db: &Connection, id: &str) -> ApiResult<()> {
    if companion(db, id)? {
        return Err(Error(
            StatusCode::FORBIDDEN,
            "Profile companions do not send device telemetry or control shared hardware",
        ));
    }
    Ok(())
}

pub fn command_allowed(db: &Connection, id: &str, kind: &str) -> ApiResult<()> {
    if companion(db, id)? && !COMMANDS.contains(&kind) {
        return Err(Error(
            StatusCode::FORBIDDEN,
            "This command belongs to the primary phone, not a profile companion",
        ));
    }
    Ok(())
}

// Children first so an explicitly erased phone archive can release its self-FK.
pub fn members(db: &Connection, id: &str) -> rusqlite::Result<Vec<String>> {
    db.prepare("SELECT id FROM devices WHERE id=? OR primary_device_id=? ORDER BY primary_device_id IS NULL")?
        .query_map([id,id], |r| r.get(0))?.collect()
}

pub fn grouped(rows: Vec<Value>) -> Vec<Value> {
    rows.iter()
        .filter(|r| r["primary_device_id"].is_null())
        .map(|r| {
            let mut primary = r.clone();
            primary["profiles"] = Value::Array(
                rows.iter()
                    .filter(|p| p["primary_device_id"] == r["id"])
                    .cloned()
                    .collect(),
            );
            primary
        })
        .collect()
}
