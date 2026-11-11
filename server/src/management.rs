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
    #[serde(skip_serializing)]
    pub managed_dns: bool, // Legacy policy rejection only; never applied.
    pub auto_resume: bool,
    pub always_on: bool,
    pub protect_settings: bool,
    pub prevent_uninstall: bool,
    pub require_strong_lock: bool,
    pub blocked_apps: Vec<String>,
    pub lost_mode: bool,
    pub haste: bool,
    pub recovery_message: String,
}
impl Policy {
    pub fn reversible(&self) -> Self {
        Self {
            lost_mode: self.lost_mode,
            haste: self.haste && self.lost_mode,
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
    #[serde(skip_serializing)]
    pub sharing_epoch: Option<String>,
    #[serde(skip_serializing)]
    pub sharing_events: Vec<crate::sharing::Event>,
    pub sharing_events_dropped: u64,
    pub runtime_sequence: Option<i64>,
    pub profile_fingerprint: Option<String>,
    pub foreground_user: Option<bool>,
    pub profile_capabilities: Option<Vec<String>>,
    pub app_signer_sha256: Option<String>,
    #[serde(skip_serializing)]
    pub system_dns: Option<serde::de::IgnoredAny>, // Discard reports from older phones.
    pub camera: Option<CameraReport>,
    pub connection_health: Option<ConnectionHealth>,
    pub owner: bool,
    pub consent: bool,
    pub recovery_consent: bool,
    pub revision: i64,
    #[serde(skip_serializing)]
    pub dns_active: Option<serde::de::IgnoredAny>,
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
pub struct ConnectionHealth {
    pub since: i64,
    pub reported_at: i64,
    pub connection: String,
    pub system_vpn: Option<bool>,
    pub signal_dbm: Option<i32>,
    pub attempts: u64,
    pub succeeded: u64,
    pub last_rtt_ms: Option<u64>,
    pub mean_rtt_ms: u64,
    pub jitter_ms: u64,
}
impl ConnectionHealth {
    fn valid(&self) -> bool {
        self.since > 0
            && self.since <= self.reported_at
            && self.reported_at <= now() + 120
            && ["offline", "wifi", "cellular", "ethernet", "vpn", "other"]
                .contains(&self.connection.as_str())
            && self.signal_dbm.is_none_or(|v| (-150..=0).contains(&v))
            && self.succeeded <= self.attempts
            && self.attempts <= 9_007_199_254_740_991
            && self.last_rtt_ms.is_none_or(|v| v <= 86400000)
            && self.mean_rtt_ms <= 86400000
            && self.jitter_ms <= 86400000
    }
}
#[derive(Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CameraReport {
    pub armed: bool,
    pub pending: u32,
    pub dropped: u64,
    pub status: String,
    pub reported_at: i64,
    pub failed_in_row: u32,
    pub queued: Vec<QueuedPhoto>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueuedPhoto {
    pub id: String,
    pub captured_at: i64,
    pub reason: String,
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
        json!({"server_version":crate::release::version(),"app_update_preparation":crate::app_updates::preparation(),"app_update":crate::app_updates::descriptor(),"revision":revision,"policy":policy.reversible(),"persistent_controls_enabled":false,"legacy_policy_present":policy.has_persistent_controls(),"report":report.and_then(|s|serde_json::from_str::<Report>(&s).ok())}),
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
    crate::profiles::require_primary(&app.db.lock().unwrap(), &id)?;
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
    let companion = crate::profiles::companion(&app.db.lock().unwrap(), &id)?;
    if r.profile_capabilities.as_ref().is_some_and(|caps| {
        !companion
            || caps.len() > crate::profiles::COMMANDS.len()
            || caps
                .iter()
                .any(|kind| !crate::profiles::COMMANDS.contains(&kind.as_str()))
            || (!r.recovery_consent && !caps.is_empty())
    }) {
        return Err(bad("Invalid profile message permissions"));
    }
    if companion
        && (r.connection_health.is_some()
            || r.delivery.is_some()
            || r.owner
            || r.consent
            || r.always_on
            || r.uninstall_blocked
            || r.protection_active
            || r.strong_lock_required
            || !r.blocked_apps.is_empty()
            || !r.android_version.is_empty()
            || !r.security_patch.is_empty())
    {
        return Err(bad(
            "Profile companions send only camera, unlock and message status",
        ));
    }
    if !crate::sharing::valid(&r.sharing_events)
        || r.sharing_events_dropped > 9_007_199_254_740_991
        || r.sharing_epoch
            .as_ref()
            .is_some_and(|e| e.len() != 43 && e.len() != 64)
        || r.camera.as_ref().is_some_and(|c| {
            c.pending > crate::photos::MAX_PENDING
                || c.queued.len() > crate::photos::MAX_PENDING as usize
                || c.queued.iter().any(|p| {
                    uuid::Uuid::parse_str(&p.id).is_err()
                        || p.captured_at <= 0
                        || p.captured_at > now() + 120
                        || !["local_test", "failed_unlock", "remote_manual"]
                            .contains(&p.reason.as_str())
                })
                || c.failed_in_row > 3
                || c.dropped > 9_007_199_254_740_991
                || c.status.len() > 240
                || c.reported_at <= 0
                || c.reported_at > now() + 120
        })
        || r.delivery.as_ref().is_some_and(|d| !d.valid())
        || r.connection_health.as_ref().is_some_and(|c| !c.valid())
        || r.app_signer_sha256.as_ref().is_some_and(|value| {
            value.len() != 64
                || !value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
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
    crate::runtime::fence(&db, &id, &headers)?;
    let (revision, policy) = read(&db, &id)?;
    if r.revision > revision {
        return Err(bad("Unknown policy revision"));
    }
    let multi: bool = db.query_row(
        "SELECT profiles_enabled OR primary_device_id IS NOT NULL FROM devices WHERE id=?",
        [&id],
        |r| r.get(0),
    )?;
    if multi && let Some(f) = r.profile_fingerprint.as_deref() {
        if !crate::runtime::fingerprint(f) {
            return Err(bad("Invalid profile identity"));
        }
        crate::profiles::check_fingerprint(&db, &id, f)?;
        db.execute("UPDATE devices SET profile_fingerprint=? WHERE id=? AND (profile_fingerprint IS NULL OR profile_fingerprint=?)",params![f,id,f])?;
        let matches: bool = db.query_row(
            "SELECT profile_fingerprint=? FROM devices WHERE id=?",
            params![f, id],
            |r| r.get(0),
        )?;
        if !matches {
            return Err(Error(
                StatusCode::CONFLICT,
                "This pairing belongs to another Android profile",
            ));
        }
    }
    let ordered = if headers.contains_key("x-bungee-instance") {
        if let Some(seq) = r.runtime_sequence.filter(|v| *v > 0) {
            db.execute("UPDATE device_runtimes SET report_sequence=? WHERE device_id=? AND report_sequence<?",params![seq,id,seq])?==1
        } else if serde_json::from_slice::<Value>(&body)
            .is_ok_and(|v| v["report"].as_object().is_some_and(|r| r.is_empty()))
        {
            false
        } else {
            return Err(bad("A runtime report sequence is required"));
        }
    } else {
        true
    };
    let changed = if ordered {
        db.execute(
        "UPDATE devices SET management_report=?,management_report_at=? WHERE id=? AND revoked=0",
        params![serde_json::to_string(r).unwrap(), now(), id],
    )?
    } else {
        1
    };
    if changed != 1 {
        return Err(denied());
    }
    if ordered && let Some(caps) = &r.profile_capabilities {
        db.execute(
            "UPDATE devices SET capabilities=? WHERE id=?",
            params![serde_json::to_string(caps).unwrap(), id],
        )?;
    }
    let epoch: String = db.query_row(
        "SELECT gps_epoch FROM devices WHERE id=? AND revoked=0",
        [&id],
        |r| r.get(0),
    )?;
    let accepted_sharing_events = if ordered {
        crate::sharing::commit(&db, &id, r.sharing_epoch.as_deref(), &r.sharing_events)?
    } else {
        vec![]
    };
    let sharing_epoch = crate::sharing::epoch(&db, &id)?;
    Ok(Json(
        json!({"server_version":crate::release::version(),"sharing_epoch":sharing_epoch,"accepted_sharing_events":accepted_sharing_events,"app_update_preparation":crate::app_updates::preparation(),"app_update":crate::app_updates::for_signer(r.app_signer_sha256.as_deref()),"revision":revision,"policy":if companion {Policy::default()} else {policy.reversible()},"profile_companion":companion,"profile":crate::profiles::metadata(&db,&id)?,"report_accepted":ordered,"gps_epoch":epoch,"photo_epoch":db.query_row("SELECT photo_epoch FROM devices WHERE id=?",[&id],|r|r.get::<_,String>(0))?,"server_time":now(),"persistent_controls_enabled":false}),
    ))
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
