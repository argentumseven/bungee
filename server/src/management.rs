use crate::{App, security::*, store};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Policy {
    pub managed_dns: bool,
    pub auto_resume: bool,
    pub always_on: bool,
    pub protect_settings: bool,
    pub prevent_uninstall: bool,
    pub require_strong_lock: bool,
    pub blocked_apps: Vec<String>,
    pub lost_mode: bool,
    pub recovery_message: String,
}
impl Policy {
    pub fn reversible(&self) -> Self {
        Self {
            lost_mode: self.lost_mode,
            recovery_message: self.recovery_message.clone(),
            ..Self::default()
        }
    }
    pub fn has_persistent_controls(&self) -> bool {
        self.managed_dns
            || self.auto_resume
            || self.always_on
            || self.protect_settings
            || self.prevent_uninstall
            || self.require_strong_lock
            || !self.blocked_apps.is_empty()
    }
    fn valid(&self) -> bool {
        (!self.managed_dns || self.always_on)
            && self.recovery_message.chars().count() <= 240
            && !self
                .recovery_message
                .chars()
                .any(|c| c.is_control() && c != '\n')
            && (!self.lost_mode || !self.recovery_message.trim().is_empty())
            && self.blocked_apps.len() <= 20
            && self.blocked_apps.iter().all(|p| safe_package(p))
    }
}
pub fn safe_package(p: &str) -> bool {
    p.len() <= 160
        && p.contains('.')
        && p != "org.bungee.app"
        && p != "android"
        && !p.starts_with("com.android.")
        && p.split('.').all(|s| {
            !s.is_empty()
                && s.as_bytes()[0].is_ascii_alphabetic()
                && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        })
}
#[derive(Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Report {
    pub owner: bool,
    pub consent: bool,
    pub recovery_consent: bool,
    pub revision: i64,
    pub dns_active: bool,
    pub always_on: bool,
    pub uninstall_blocked: bool,
    pub protection_active: bool,
    pub strong_lock_required: bool,
    pub blocked_apps: Vec<String>,
    pub lost_mode_active: bool,
    pub errors: Vec<String>,
    pub android_version: String,
    pub security_patch: String,
    pub secure_lock: bool,
    pub screen_locked: bool,
    pub unlock_monitoring: bool,
    pub failed_unlocks: u32,
    pub last_failed_at: Option<i64>,
    pub delivery: Option<DeliveryReport>,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DeliveryReport {
    pub reported_at: i64,
    pub queued_fixes: u32,
    pub dropped_fixes: u64,
    pub oldest_queued_at: Option<i64>,
    pub pending_receipts: u32,
    pub gps_access: Option<String>,
}
impl DeliveryReport {
    fn valid(&self) -> bool {
        self.reported_at > 0
            && self.reported_at <= now() + 120
            && self.queued_fixes <= 10080
            && self.dropped_fixes <= 9_007_199_254_740_991
            && self.pending_receipts <= 100
            && self.gps_access.as_deref().is_none_or(|v| {
                [
                    "paused",
                    "disabled",
                    "permission_denied",
                    "start_restricted",
                    "needs_foreground_start",
                    "foreground",
                    "background",
                ]
                .contains(&v)
            })
            && self.oldest_queued_at.is_none_or(|t| t > 0)
    }
}
fn read(db: &rusqlite::Connection, id: &str) -> ApiResult<(i64, Policy)> {
    let saved: Option<(i64, String)> = db
        .query_row(
            "SELECT revision,policy FROM device_policies WHERE device_id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match saved {
        Some((revision, policy)) => Ok((
            revision,
            serde_json::from_str(&policy).map_err(|_| bad("Stored policy is invalid"))?,
        )),
        None => Ok((0, Policy::default())),
    }
}
pub async fn get_policy(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let db = app.db.lock().unwrap();
    let report: Option<Option<String>> = db
        .query_row(
            "SELECT management_report FROM devices WHERE id=? AND revoked=0",
            [&id],
            |r| r.get(0),
        )
        .optional()?;
    let report = report.ok_or(Error(StatusCode::NOT_FOUND, "Device not found"))?;
    let (revision, policy) = read(&db, &id)?;
    Ok(Json(
        json!({"revision":revision,"policy":policy.reversible(),"persistent_controls_enabled":false,"legacy_policy_present":policy.has_persistent_controls(),"report":report.and_then(|s|serde_json::from_str::<Value>(&s).ok()),"dns_configured":app.dns.is_some(),"dns_upstream":app.dns.as_ref().map(|d|d.upstream.to_string())}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Save {
    expected_revision: i64,
    policy: Policy,
}
pub async fn save_policy(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<Save>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    if !input.policy.valid() || input.expected_revision < 0 {
        return Err(bad("Invalid policy, package list or recovery message"));
    }
    if input.policy.has_persistent_controls() {
        return Err(bad(
            "Persistent device-owner controls are disabled by the reversibility policy",
        ));
    }
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    let report:Option<Option<String>>=tx.query_row("SELECT management_report FROM devices WHERE id=? AND revoked=0 AND public_key IS NOT NULL",[&id],|r|r.get(0)).optional()?;
    let report: Report = report
        .ok_or(Error(StatusCode::NOT_FOUND, "Enrolled phone not found"))?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if input.policy.lost_mode && !report.recovery_consent {
        return Err(bad("The phone must locally approve recovery controls"));
    }
    let (revision, _) = read(&tx, &id)?;
    if revision != input.expected_revision {
        return Err(Error(
            StatusCode::CONFLICT,
            "Policy changed; reload before saving",
        ));
    }
    let revision = revision
        .checked_add(1)
        .ok_or_else(|| bad("Policy revision limit reached"))?;
    tx.execute("INSERT INTO device_policies VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET revision=excluded.revision,policy=excluded.policy",params![id,revision,serde_json::to_string(&input.policy).unwrap()])?;
    store::audit(
        &tx,
        "policy.updated",
        Some(&id),
        "Recovery/management policy updated; awaiting phone report",
    )?;
    tx.commit()?;
    Ok(Json(json!({"revision":revision,"policy":input.policy})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sync {
    report: Report,
}
pub async fn sync(
    State(app): State<App>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let id = verify_device(&app, &headers, "/v1/sync", &body)?;
    let input: Sync =
        serde_json::from_slice(&body).map_err(|_| bad("Invalid management report"))?;
    let r = &input.report;
    if r.delivery.as_ref().is_some_and(|d| !d.valid())
        || r.revision < 0
        || r.errors.len() > 20
        || r.errors.iter().any(|e| e.len() > 160)
        || r.blocked_apps.len() > 20
        || r.blocked_apps.iter().any(|p| !safe_package(p))
        || r.android_version.len() > 40
        || r.security_patch.len() > 20
        || r.last_failed_at.is_some_and(|v| v < 0 || v > now() + 120)
    {
        return Err(bad("Invalid management report values"));
    }
    let db = app.db.lock().unwrap();
    let (revision, policy) = read(&db, &id)?;
    if r.revision > revision {
        return Err(bad("Unknown policy revision"));
    }
    let changed = db.execute(
        "UPDATE devices SET management_report=? WHERE id=? AND revoked=0",
        params![serde_json::to_string(r).unwrap(), id],
    )?;
    if changed != 1 {
        return Err(denied());
    }
    Ok(Json(
        json!({"revision":revision,"policy":policy.reversible(),"dns_available":false,"persistent_controls_enabled":false}),
    ))
}
pub fn dns_peer(db: &rusqlite::Connection, address: &str) -> ApiResult<Option<String>> {
    let row:Option<(String,Option<String>)>=db.query_row("SELECT id,management_report FROM devices WHERE address=? AND revoked=0 AND public_key IS NOT NULL AND wg_psk IS NOT NULL",[address],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((id, Some(report))) = row else {
        return Ok(None);
    };
    let report: Report =
        serde_json::from_str(&report).map_err(|_| bad("Invalid management state"))?;
    let (revision, policy) = read(db, &id)?;
    Ok((policy.managed_dns
        && report.owner
        && report.consent
        && report.dns_active
        && report.always_on
        && report.revision == revision)
        .then_some(id))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn package_bounds_protect_core_components() {
        for p in [
            "android",
            "com.android.settings",
            "org.bungee.app",
            "a..b",
            "bad;name.app",
        ] {
            assert!(!safe_package(p));
        }
        assert!(safe_package("org.mozilla.firefox"));
    }
}
