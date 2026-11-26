use crate::{App, security::*};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Check {
    label: String,
    status: String,
    detail: String,
}

pub fn validate(kind: &str, status: &str, checks: Option<&[Check]>) -> ApiResult<Option<String>> {
    match (kind, status, checks) {
        ("diagnostics", "executed", Some(checks))
            if (1..=16).contains(&checks.len())
                && checks.iter().all(|check| {
                    (1..=48).contains(&check.label.len())
                        && (1..=240).contains(&check.detail.len())
                        && !check.label.chars().any(char::is_control)
                        && !check.detail.chars().any(char::is_control)
                        && ["ok", "attention", "info"].contains(&check.status.as_str())
                }) =>
        {
            Ok(Some(
                serde_json::to_string(checks).map_err(|_| bad("Invalid diagnostics report"))?,
            ))
        }
        ("diagnostics", "executed", _) | (_, _, Some(_)) => Err(bad("Invalid diagnostics report")),
        _ => Ok(None),
    }
}

pub async fn latest(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let db = app.db.lock().unwrap();
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM devices WHERE id=? AND revoked=0)",
        [&id],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(Error(StatusCode::NOT_FOUND, "Phone not found"));
    }
    let time = now();
    let report = db.query_row(
        "SELECT c.id,c.created,c.expires,c.status,c.result,c.receipt_received_at,c.diagnostic_checks,c.device_id,
                CASE WHEN d.primary_device_id IS NULL THEN COALESCE(d.main_profile_name,d.name) ELSE d.name END
         FROM commands c JOIN devices d ON d.id=c.device_id
         WHERE (d.id=?1 OR d.primary_device_id=?1) AND d.revoked=0 AND c.kind='diagnostics' AND c.created>=?2
         ORDER BY c.created DESC,c.rowid DESC LIMIT 1",
        params![id, time - 86400],
        |row| {
            let expires: i64 = row.get(2)?;
            let status: String = row.get(3)?;
            let expired = expires <= time && ["pending", "delivered"].contains(&status.as_str());
            let checks = row.get::<_, Option<String>>(6)?
                .and_then(|value| serde_json::from_str::<Value>(&value).ok());
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "created": row.get::<_, i64>(1)?,
                "expires": expires,
                "status": if expired { "expired" } else { &status },
                "result": row.get::<_, Option<String>>(4)?,
                "received_at": row.get::<_, Option<i64>>(5)?,
                "device_id": row.get::<_, String>(7)?,
                "profile_name": row.get::<_, String>(8)?,
                "checks": checks,
            }))
        },
    ).optional()?;
    Ok(Json(json!({"report": report})))
}
