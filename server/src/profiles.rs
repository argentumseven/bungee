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
            let children: Vec<Value> = rows
                .iter()
                .filter(|p| p["primary_device_id"] == r["id"])
                .cloned()
                .collect();
            primary["profile_invitations"] = Value::Array(
                children
                    .iter()
                    .filter(|p| p["enrolled"] != true && p["revoked"] != true)
                    .cloned()
                    .collect(),
            );
            primary["profile_archives"] = Value::Array(
                children
                    .iter()
                    .filter(|p| p["revoked"] == true)
                    .cloned()
                    .collect(),
            );
            primary["profiles"] = Value::Array(
                rows.iter()
                    .filter(|p| {
                        p["primary_device_id"] == r["id"]
                            && p["enrolled"] == true
                            && p["revoked"] != true
                    })
                    .cloned()
                    .collect(),
            );
            primary
        })
        .collect()
}

pub fn check_fingerprint(db: &Connection, id: &str, fingerprint: &str) -> ApiResult<()> {
    let duplicate: bool=db.query_row("SELECT EXISTS(SELECT 1 FROM devices other WHERE other.id<>? AND other.revoked=0 AND other.public_key IS NOT NULL AND other.profile_fingerprint=? AND COALESCE(other.primary_device_id,other.id)=(SELECT COALESCE(primary_device_id,id) FROM devices WHERE id=?))",rusqlite::params![id,fingerprint,id],|r|r.get(0))?;
    if duplicate {
        return Err(Error(
            StatusCode::CONFLICT,
            "This Android profile is already paired to this phone. Reconnect its existing profile instead",
        ));
    }
    Ok(())
}
pub fn metadata(db: &Connection, id: &str) -> ApiResult<Value> {
    let (parent, enabled, label): (Option<String>, bool, Option<String>) = db.query_row(
        "SELECT primary_device_id,profiles_enabled,main_profile_name FROM devices WHERE id=?",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if let Some(parent) = parent {
        let name: String = db.query_row("SELECT name FROM devices WHERE id=?", [&parent], |r| {
            r.get(0)
        })?;
        Ok(serde_json::json!({"role":"companion","primary_device_id":parent,"primary_name":name}))
    } else if enabled {
        Ok(serde_json::json!({"role":"main","primary_device_id":id,"profile_name":label}))
    } else {
        Ok(Value::Null)
    }
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Setup {
    main_profile_name: String,
}
pub async fn setup(
    axum::extract::State(app): axum::extract::State<crate::App>,
    headers: axum::http::HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
    axum::Json(input): axum::Json<Setup>,
) -> ApiResult<axum::Json<Value>> {
    require_admin(&app, &headers)?;
    if input.main_profile_name.trim().is_empty()
        || input.main_profile_name.chars().count() > 60
        || input.main_profile_name.chars().any(char::is_control)
    {
        return Err(bad(
            "Choose the Android user containing the main installation",
        ));
    }
    let db = app.db.lock().unwrap();
    let changed=db.execute("UPDATE devices SET profiles_enabled=1,main_profile_name=? WHERE id=? AND primary_device_id IS NULL AND revoked=0 AND public_key IS NOT NULL AND profiles_enabled=0",rusqlite::params![input.main_profile_name.trim(),id])?;
    if changed != 1 {
        return Err(Error(
            StatusCode::CONFLICT,
            "Choose a normally paired phone that has not already enabled profiles",
        ));
    }
    crate::store::audit(
        &db,
        "profiles.enabled",
        Some(&id),
        "Existing installation selected as main; awaiting profile confirmation",
    )?;
    Ok(axum::Json(
        serde_json::json!({"enabled":true,"main_profile_name":input.main_profile_name.trim()}),
    ))
}
