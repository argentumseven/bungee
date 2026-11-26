use crate::security::*;
use axum::http::StatusCode;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

pub const COMMANDS: &[&str] = &[
    "message",
    "clear_message",
    "stop_all",
    "take_picture",
    "diagnostics",
];
const PROFILE_ACTIONS: &[&str] = &["message", "clear_message", "take_picture", "diagnostics"];

#[derive(serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Focus {
    Active { id: String, since_ms: Option<i64> },
    Switching,
    Unknown,
}

pub fn focus(db: &Connection, phone: &str, time: i64) -> rusqlite::Result<Focus> {
    let mut query = db.prepare(
        "SELECT id,json_extract(management_report,'$.foreground_since_ms'),
                COALESCE(last_contact>?2 AND management_report_at>?2 AND json_extract(management_report,'$.foreground_user')=1,0)
         FROM devices WHERE (id=?1 OR primary_device_id=?1) AND revoked=0 AND public_key IS NOT NULL
         ORDER BY 2 DESC",
    )?;
    let reports = query
        .query_map(params![phone, time - 90], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut legacy = reports
        .iter()
        .filter(|(_, since, active)| since.is_none() && *active);
    if let Some((id, Some(since), active)) = reports.first() {
        // Keep the newest transition even after its owner goes to the background.
        // An older positive report must never become current again by default.
        if !active {
            return Ok(Focus::Unknown);
        }
        if reports
            .get(1)
            .is_some_and(|(_, other, _)| *other == Some(*since))
            || legacy.next().is_some()
        {
            return Ok(Focus::Switching);
        }
        return Ok(Focus::Active {
            id: id.clone(),
            since_ms: Some(*since),
        });
    }
    match (legacy.next(), legacy.next()) {
        (Some((id, _, _)), None) => Ok(Focus::Active {
            id: id.clone(),
            since_ms: None,
        }),
        (Some(_), Some(_)) => Ok(Focus::Switching),
        _ => Ok(Focus::Unknown),
    }
}

pub fn command_target(
    db: &Connection,
    phone: String,
    selection: Option<&str>,
    kind: &str,
) -> ApiResult<(String, bool)> {
    let Some(selection) = selection else {
        return Ok((phone, false));
    };
    if !PROFILE_ACTIONS.contains(&kind) {
        return Err(bad("This command uses the main installation"));
    }
    let multi = db.query_row(
        "SELECT profiles_enabled FROM devices WHERE id=? AND primary_device_id IS NULL AND revoked=0 AND public_key IS NOT NULL",
        [&phone], |row| row.get::<_, bool>(0),
    ).optional()?.ok_or(Error(StatusCode::NOT_FOUND, "Paired phone not found"))?;
    if selection == "active" {
        if !multi {
            return Ok((phone, false));
        }
        return match focus(db, &phone, now())? {
            Focus::Active {
                id,
                since_ms: Some(_),
            } => Ok((id, true)),
            // The existing camera command independently verifies foreground on the phone.
            Focus::Active { id, since_ms: None } if kind == "take_picture" => Ok((id, false)),
            Focus::Active { .. } => Err(Error(
                StatusCode::CONFLICT,
                "Choose a profile manually until the active installation reports foreground support",
            )),
            Focus::Switching => Err(Error(
                StatusCode::CONFLICT,
                "Android profile switch in progress",
            )),
            Focus::Unknown => Err(Error(
                StatusCode::CONFLICT,
                "No linked Android profile has reported foreground recently",
            )),
        };
    }
    let member: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM devices WHERE id=?1 AND (id=?2 OR primary_device_id=?2)
         AND revoked=0 AND public_key IS NOT NULL)",
        params![selection, phone],
        |row| row.get(0),
    )?;
    if !member {
        return Err(Error(
            StatusCode::NOT_FOUND,
            "Profile is not paired to this phone",
        ));
    }
    Ok((selection.to_owned(), false))
}

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
