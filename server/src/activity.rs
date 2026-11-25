//! Household activity: administrator audit entries and phone-reported device events in one
//! chronological, cursor-paginated feed, with explicit purges and bounded self-trimming so the
//! logs cannot grow until they threaten the database.
//!
//! Retention is deliberately conservative. Nothing is deleted by age unless an administrator
//! chose an age; the always-on ceilings are far above normal household use and only ever remove
//! the oldest rows. A phone's newest saved GPS point is never trimmed or purged by age, so the
//! last-known recovery position survives a long outage.
use crate::{App, security::*, store};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};

/// Administrator audit entries kept (oldest removed first).
pub const AUDIT_MAX_ROWS: i64 = 20_000;
/// Phone-reported events kept per phone (profiles count with their phone).
pub const EVENTS_MAX_PER_PHONE: i64 = 10_000;
/// Safety ceiling for each of GPS points, check-ins and IP observations per phone.
pub const HISTORY_MAX_PER_PHONE: i64 = 2_000_000;
/// One maintenance pass never removes more than this many rows per table and phone, so the
/// shared database lock stays short even after a very large backlog.
const TRIM_BATCH: i64 = 20_000;
const MAX_AGE_DAYS: i64 = 3650;
const PAGE_MAX: usize = 100;
/// Ages the dashboard offers for automatic cleanup. Zero keeps everything.
const AGE_CHOICES: &[i64] = &[0, 7, 14, 30, 60, 90, 180, 365, 730];

fn state_reasons() -> String {
    crate::sharing::DEVICE_STATE
        .iter()
        .map(|r| format!("'{r}'"))
        .collect::<Vec<_>>()
        .join(",")
}

#[derive(Deserialize)]
pub struct ListQuery {
    before: Option<String>,
    limit: Option<usize>,
    device: Option<String>,
    group: Option<String>,
}

/// Total order of the feed: newest time first; at equal times phone events before audit
/// entries; then newest row first. The cursor names the last row already returned.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Cursor {
    ts: i64,
    rank: i64,
    id: i64,
}
const AUDIT: i64 = 0;
const EVENT: i64 = 1;
impl Cursor {
    fn parse(text: &str) -> Option<Self> {
        let mut parts = text.split('.');
        let cursor = Self {
            ts: parts.next()?.parse().ok()?,
            rank: parts.next()?.parse().ok()?,
            id: parts.next()?.parse().ok()?,
        };
        (parts.next().is_none()
            && cursor.ts >= 0
            && [AUDIT, EVENT].contains(&cursor.rank)
            && cursor.id >= 0)
            .then_some(cursor)
    }
    fn text(&self) -> String {
        format!("{}.{}.{}", self.ts, self.rank, self.id)
    }
    /// Rows of `rank` that sort strictly after this cursor satisfy
    /// `ts < cursor.ts OR (ts = cursor.ts AND id < bound)`.
    fn id_bound(&self, rank: i64) -> i64 {
        match rank.cmp(&self.rank) {
            std::cmp::Ordering::Greater => i64::MIN,
            std::cmp::Ordering::Equal => self.id,
            std::cmp::Ordering::Less => i64::MAX,
        }
    }
}

pub async fn list(
    State(app): State<App>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let limit = query.limit.unwrap_or(50);
    let group = query.group.as_deref().unwrap_or("all");
    let cursor = match query.before.as_deref() {
        Some(text) => Some(Cursor::parse(text).ok_or_else(|| bad("Invalid activity cursor"))?),
        None => None,
    };
    if !(1..=PAGE_MAX).contains(&limit)
        || !["all", "admin", "phone", "device_state", "sharing"].contains(&group)
        || query.device.as_deref().is_some_and(|d| d.len() > 64)
    {
        return Err(bad("Invalid activity filter"));
    }
    let db = app.db.lock().unwrap();
    if let Some(device) = &query.device {
        let exists: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM devices WHERE id=?)",
            [device],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(Error(StatusCode::NOT_FOUND, "Device not found"));
        }
    }
    let after = cursor.unwrap_or(Cursor {
        ts: i64::MAX,
        rank: EVENT,
        id: i64::MAX,
    });
    let mut rows: Vec<(Cursor, Value)> = Vec::new();
    if group == "all" || group == "admin" {
        let mut q = db.prepare(
            "SELECT id,at,action,device_id,detail FROM audit
             WHERE (?1 IS NULL OR device_id IN (SELECT id FROM devices WHERE id=?1 OR primary_device_id=?1))
               AND (at<?2 OR (at=?2 AND id<?3))
             ORDER BY at DESC,id DESC LIMIT ?4",
        )?;
        let found = q.query_map(
            params![
                query.device,
                after.ts,
                after.id_bound(AUDIT),
                limit as i64 + 1
            ],
            |r| {
                let (id, at): (i64, i64) = (r.get(0)?, r.get(1)?);
                Ok((
                    Cursor {
                        ts: at,
                        rank: AUDIT,
                        id,
                    },
                    json!({"source":"server","id":format!("a{id}"),"ts":at,"at":at,"action":r.get::<_,String>(2)?,"device_id":r.get::<_,Option<String>>(3)?,"detail":r.get::<_,String>(4)?}),
                ))
            },
        )?;
        for row in found {
            rows.push(row?);
        }
    }
    if group != "admin" {
        let reasons = state_reasons();
        let filter = match group {
            "device_state" => format!("AND e.reason IN ({reasons})"),
            "sharing" => format!("AND e.reason NOT IN ({reasons})"),
            _ => String::new(),
        };
        let mut q = db.prepare(&format!(
            "SELECT e.sequence,e.event_id,e.reason,e.at,e.recorded_at,e.received_at,d.id,d.name,d.primary_device_id,e.detail,COALESCE(e.at,e.recorded_at)
             FROM sharing_events e JOIN devices d ON d.id=e.device_id
             WHERE (?1 IS NULL OR d.id=?1 OR d.primary_device_id=?1)
               AND (COALESCE(e.at,e.recorded_at)<?2 OR (COALESCE(e.at,e.recorded_at)=?2 AND e.sequence<?3)) {filter}
             ORDER BY COALESCE(e.at,e.recorded_at) DESC,e.sequence DESC LIMIT ?4"
        ))?;
        let found = q.query_map(
            params![
                query.device,
                after.ts,
                after.id_bound(EVENT),
                limit as i64 + 1
            ],
            |r| {
                let sequence: i64 = r.get(0)?;
                let code: String = r.get(2)?;
                let (kind, category, label) = crate::sharing::reason(&code).unwrap_or((
                    "unknown",
                    "unknown",
                    "Unrecognized phone event",
                ));
                let profile = r.get::<_, Option<String>>(8)?.is_some();
                Ok((
                    Cursor {
                        ts: r.get(10)?,
                        rank: EVENT,
                        id: sequence,
                    },
                    json!({"source":"phone","id":r.get::<_,String>(1)?,"sequence":sequence,"ts":r.get::<_,i64>(10)?,
                        "reason":code,"kind":kind,"category":category,"label":label,
                        "at":r.get::<_,Option<i64>>(3)?,"recorded_at":r.get::<_,i64>(4)?,"received_at":r.get::<_,i64>(5)?,
                        "device_id":r.get::<_,String>(6)?,
                        "phone_name":r.get::<_,String>(7)?,
                        "profile_name":if profile {r.get::<_,Option<String>>(7)?} else {None},
                        "detail":r.get::<_,Option<String>>(9)?.and_then(|text|serde_json::from_str::<Value>(&text).ok())}),
                ))
            },
        )?;
        for row in found {
            rows.push(row?);
        }
    }
    rows.sort_by(|a, b| (b.0.ts, b.0.rank, b.0.id).cmp(&(a.0.ts, a.0.rank, a.0.id)));
    let more = rows.len() > limit;
    rows.truncate(limit);
    let next = if more {
        rows.last().map(|(cursor, _)| cursor.text())
    } else {
        None
    };
    Ok(Json(
        json!({"events":rows.into_iter().map(|(_, row)| row).collect::<Vec<_>>(),"next_before":next}),
    ))
}

#[derive(Deserialize)]
pub struct PurgeQuery {
    device: Option<String>,
    older_than_days: Option<i64>,
    scope: Option<String>,
}

fn valid_age(days: Option<i64>) -> bool {
    days.is_none_or(|d| (1..=MAX_AGE_DAYS).contains(&d))
}

/// Remove activity. Without `older_than_days` everything in scope goes and each affected
/// phone's event generation rotates, so events still queued on a phone cannot restore it.
/// With an age only older rows go; a per-phone floor stops late old events being stored again.
pub async fn purge(
    State(app): State<App>,
    headers: HeaderMap,
    Query(query): Query<PurgeQuery>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let scope = query.scope.as_deref().unwrap_or("all");
    if !["all", "admin", "phone"].contains(&scope)
        || !valid_age(query.older_than_days)
        || query.device.as_deref().is_some_and(|d| d.len() > 64)
    {
        return Err(bad("Invalid activity purge request"));
    }
    let cutoff = query.older_than_days.map(|d| now() - d * 86_400);
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    let members: Vec<String> = match &query.device {
        Some(id) => {
            let found = crate::profiles::members(&tx, id)?;
            if found.is_empty() {
                return Err(Error(StatusCode::NOT_FOUND, "Device not found"));
            }
            found
        }
        None => tx
            .prepare("SELECT id FROM devices")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?,
    };
    let mut phone_removed = 0usize;
    if scope != "admin" {
        for member in &members {
            match cutoff {
                Some(cutoff) => {
                    phone_removed += tx.execute(
                        "DELETE FROM sharing_events WHERE device_id=? AND COALESCE(at,recorded_at)<?",
                        params![member, cutoff],
                    )?;
                    tx.execute(
                        "UPDATE devices SET activity_floor=MAX(activity_floor,?) WHERE id=?",
                        params![cutoff, member],
                    )?;
                }
                None => {
                    phone_removed +=
                        tx.execute("DELETE FROM sharing_events WHERE device_id=?", [member])?;
                    tx.execute(
                        "UPDATE devices SET sharing_epoch=? WHERE id=?",
                        params![token(), member],
                    )?;
                }
            }
        }
    }
    let mut server_removed = 0usize;
    if scope != "phone" {
        match (&query.device, cutoff) {
            (None, Some(cutoff)) => {
                server_removed += tx.execute("DELETE FROM audit WHERE at<?", [cutoff])?;
            }
            (None, None) => {
                server_removed += tx.execute("DELETE FROM audit", [])?;
            }
            (Some(_), cutoff) => {
                for member in &members {
                    server_removed += match cutoff {
                        Some(cutoff) => tx.execute(
                            "DELETE FROM audit WHERE device_id=? AND at<?",
                            params![member, cutoff],
                        )?,
                        None => tx.execute("DELETE FROM audit WHERE device_id=?", [member])?,
                    };
                }
            }
        }
    }
    // The purge itself stays on the record, so clearing the log is never silent.
    let age = match query.older_than_days {
        Some(days) => format!("older than {days} days"),
        None => "all".to_owned(),
    };
    let detail = format!(
        "Activity purged ({age}, {scope}): {server_removed} administrator entries and {phone_removed} phone events removed"
    );
    store::audit(&tx, "activity.purged", query.device.as_deref(), &detail)?;
    tx.commit()?;
    Ok(Json(
        json!({"purged":true,"server_removed":server_removed,"phone_removed":phone_removed}),
    ))
}

#[derive(Deserialize)]
pub struct GpsPurgeQuery {
    older_than_days: Option<i64>,
}

/// Without an age this is the existing complete GPS erasure (which rotates the GPS generation so
/// queued fixes cannot restore it). With an age only older points are removed: the generation is
/// untouched, so a phone's legitimate offline backlog still uploads, and the newest point stays.
pub async fn purge_gps(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<GpsPurgeQuery>,
) -> ApiResult<Json<Value>> {
    let Some(days) = query.older_than_days else {
        return crate::api::erase_history(&app, &headers, &id, false);
    };
    require_admin(&app, &headers)?;
    if !valid_age(Some(days)) {
        return Err(bad("Choose between 1 and 3650 days"));
    }
    let cutoff = now() - days * 86_400;
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM devices WHERE id=? AND revoked=0 AND public_key IS NOT NULL)",
        [&id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(Error(StatusCode::NOT_FOUND, "Enrolled device not found"));
    }
    let removed = tx.execute(
        "DELETE FROM location_history WHERE device_id=?1 AND observed_at<?2
         AND observed_at<(SELECT MAX(observed_at) FROM location_history WHERE device_id=?1)",
        params![id, cutoff],
    )?;
    // Running exports and history reads notice the change and retry.
    tx.execute(
        "UPDATE devices SET history_revision=history_revision+1 WHERE id=?",
        [&id],
    )?;
    store::audit(
        &tx,
        "location.purged",
        Some(&id),
        &format!(
            "{removed} saved GPS points older than {days} days removed; the newest point was kept"
        ),
    )?;
    tx.commit()?;
    Ok(Json(json!({"purged":true,"removed":removed})))
}

fn setting(db: &Connection) -> rusqlite::Result<(i64, i64)> {
    db.query_row(
        "SELECT gps_days,activity_days FROM retention_settings WHERE id=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}

fn count(db: &Connection, sql: &str) -> rusqlite::Result<i64> {
    db.query_row(sql, [], |r| r.get(0))
}

pub async fn retention(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let db = app.db.lock().unwrap();
    let (gps_days, activity_days) = setting(&db)?;
    let size = ["bungee.sqlite3", "bungee.sqlite3-wal"]
        .iter()
        .filter_map(|name| std::fs::metadata(app.state_dir.join(name)).ok())
        .map(|m| m.len())
        .sum::<u64>();
    Ok(Json(json!({
        "gps_days":gps_days,"activity_days":activity_days,"choices":AGE_CHOICES,
        "limits":{"audit":AUDIT_MAX_ROWS,"events_per_phone":EVENTS_MAX_PER_PHONE,"history_per_phone":HISTORY_MAX_PER_PHONE},
        "usage":{
            "audit":count(&db,"SELECT COUNT(*) FROM audit")?,
            "phone_events":count(&db,"SELECT COUNT(*) FROM sharing_events")?,
            "gps_points":count(&db,"SELECT COUNT(*) FROM location_history")?,
            "checkins":count(&db,"SELECT COUNT(*) FROM state_history")?,
            "ip_observations":count(&db,"SELECT COUNT(*) FROM network_history")?,
            "database_bytes":size
        }
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetentionInput {
    gps_days: i64,
    activity_days: i64,
}

pub async fn set_retention(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<RetentionInput>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    if !AGE_CHOICES.contains(&input.gps_days) || !AGE_CHOICES.contains(&input.activity_days) {
        return Err(bad("Choose one of the offered cleanup ages"));
    }
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    tx.execute(
        "UPDATE retention_settings SET gps_days=?,activity_days=? WHERE id=1",
        params![input.gps_days, input.activity_days],
    )?;
    store::audit(
        &tx,
        "retention.updated",
        None,
        &format!(
            "Automatic cleanup: GPS {}, activity {}",
            describe(input.gps_days),
            describe(input.activity_days)
        ),
    )?;
    tx.commit()?;
    Ok(Json(
        json!({"gps_days":input.gps_days,"activity_days":input.activity_days}),
    ))
}

fn describe(days: i64) -> String {
    if days == 0 {
        "kept".into()
    } else {
        format!("removed after {days} days")
    }
}

/// Delete at most `TRIM_BATCH` of the oldest rows beyond `keep` for one phone.
fn trim_excess(
    db: &Connection,
    table: &str,
    order: &str,
    device: &str,
    keep: i64,
) -> rusqlite::Result<usize> {
    // `order` and `table` are fixed strings chosen below, never request data.
    let threshold: Option<i64> = db
        .query_row(
            &format!("SELECT {order} FROM {table} WHERE device_id=? ORDER BY {order} DESC LIMIT 1 OFFSET ?"),
            params![device, keep],
            |r| r.get(0),
        )
        .optional()?;
    let Some(threshold) = threshold else {
        return Ok(0);
    };
    db.execute(
        &format!(
            "DELETE FROM {table} WHERE device_id=?1 AND {order} IN (
               SELECT {order} FROM {table} WHERE device_id=?1 AND {order}<=?2 ORDER BY {order} LIMIT ?3)"
        ),
        params![device, threshold, TRIM_BATCH],
    )
}

/// Housekeeping. Cheap activity trimming runs on every call; the larger history ceilings and
/// the administrator's optional age cleanup run about every ten minutes.
pub fn maintain(app: &App, tick: u64) -> ApiResult<()> {
    let db = app.db.lock().unwrap();
    db.execute(
        "DELETE FROM audit WHERE id < (SELECT COALESCE(MAX(id),0)-? FROM audit)",
        [AUDIT_MAX_ROWS],
    )?;
    let devices: Vec<String> = db
        .prepare("SELECT id FROM devices")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for id in &devices {
        trim_excess(&db, "sharing_events", "sequence", id, EVENTS_MAX_PER_PHONE)?;
    }
    if !tick.is_multiple_of(10) {
        return Ok(());
    }
    let mut removed = 0;
    for id in &devices {
        removed += trim_excess(
            &db,
            "location_history",
            "observed_at",
            id,
            HISTORY_MAX_PER_PHONE,
        )?;
        removed += trim_excess(
            &db,
            "network_history",
            "observed_at",
            id,
            HISTORY_MAX_PER_PHONE,
        )?;
        removed += trim_excess(&db, "state_history", "id", id, HISTORY_MAX_PER_PHONE)?;
    }
    let (gps_days, activity_days) = setting(&db)?;
    if gps_days > 0 {
        let cutoff = now() - gps_days * 86_400;
        for id in &devices {
            // The newest point is the last-known recovery position; age never removes it.
            removed += db.execute(
                "DELETE FROM location_history WHERE device_id=?1 AND observed_at IN (
                   SELECT observed_at FROM location_history WHERE device_id=?1 AND observed_at<?2
                   AND observed_at<(SELECT MAX(observed_at) FROM location_history WHERE device_id=?1)
                   ORDER BY observed_at LIMIT ?3)",
                params![id, cutoff, TRIM_BATCH],
            )?;
        }
    }
    if activity_days > 0 {
        let cutoff = now() - activity_days * 86_400;
        removed += db.execute("DELETE FROM audit WHERE at<?", [cutoff])?;
        removed += db.execute(
            "DELETE FROM sharing_events WHERE COALESCE(at,recorded_at)<?",
            [cutoff],
        )?;
        // Move the floor only meaningfully, so an idle server does not rewrite it every pass.
        db.execute(
            "UPDATE devices SET activity_floor=? WHERE activity_floor<?-86400",
            params![cutoff, cutoff],
        )?;
    }
    if removed > 0 {
        tracing::info!(removed, "Automatic cleanup removed old saved records");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;

    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        // `store::open` needs a path; build the same schema in memory.
        let dir = std::env::temp_dir().join(format!("bungee-activity-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("bungee.sqlite3");
        drop(db);
        let db = store::open(&file).unwrap();
        db.execute("INSERT INTO devices(id,name,wg_key,address,created) VALUES('phone','Phone','k','10.77.0.2',1)", []).unwrap();
        db
    }

    #[test]
    fn cursor_round_trips_and_rejects_malformed_values() {
        let cursor = Cursor {
            ts: 1_700_000_000,
            rank: EVENT,
            id: 42,
        };
        assert_eq!(Cursor::parse(&cursor.text()), Some(cursor));
        for bad in [
            "", "1", "1.2", "1.1.1.1", "-1.1.1", "1.7.1", "1.1.-1", "a.b.c", "1.1.",
        ] {
            assert_eq!(Cursor::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn id_bound_orders_events_before_audit_at_equal_times() {
        let after_event = Cursor {
            ts: 10,
            rank: EVENT,
            id: 5,
        };
        // Same timestamp: remaining events must have a smaller id, every audit row still follows.
        assert_eq!(after_event.id_bound(EVENT), 5);
        assert_eq!(after_event.id_bound(AUDIT), i64::MAX);
        let after_audit = Cursor {
            ts: 10,
            rank: AUDIT,
            id: 5,
        };
        // Events at the same time were already returned before this audit row.
        assert_eq!(after_audit.id_bound(EVENT), i64::MIN);
        assert_eq!(after_audit.id_bound(AUDIT), 5);
    }

    #[test]
    fn excess_rows_are_trimmed_oldest_first_in_bounded_batches() {
        let db = database();
        for i in 0..50 {
            db.execute("INSERT INTO sharing_events(device_id,event_id,reason,at,recorded_at,received_at) VALUES('phone',?,'user_start',?,?,?)", params![format!("e{i}"), 1000 + i, 1000 + i, 1000 + i]).unwrap();
        }
        assert_eq!(
            trim_excess(&db, "sharing_events", "sequence", "phone", 20).unwrap(),
            30
        );
        let kept: Vec<i64> = db
            .prepare("SELECT at FROM sharing_events ORDER BY sequence")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(kept, (1030..1050).collect::<Vec<i64>>());
        assert_eq!(
            trim_excess(&db, "sharing_events", "sequence", "phone", 20).unwrap(),
            0
        );
    }

    #[test]
    fn age_purge_keeps_the_newest_saved_point() {
        let db = database();
        for at in [100, 200, 300] {
            db.execute("INSERT INTO location_history(device_id,observed_at,received_at,latitude,longitude,accuracy) VALUES('phone',?,?,1,2,3)", params![at, at]).unwrap();
        }
        // Everything is older than the cutoff, yet the newest point survives.
        let removed = db
            .execute(
                "DELETE FROM location_history WHERE device_id=?1 AND observed_at<?2
             AND observed_at<(SELECT MAX(observed_at) FROM location_history WHERE device_id=?1)",
                params!["phone", 10_000],
            )
            .unwrap();
        assert_eq!(removed, 2);
        assert_eq!(
            count(&db, "SELECT observed_at FROM location_history").unwrap(),
            300
        );
    }

    #[test]
    fn audit_is_capped_without_losing_the_newest_entries() {
        let db = database();
        for i in 0..(AUDIT_MAX_ROWS + 25) {
            db.execute(
                "INSERT INTO audit(at,action,device_id,detail) VALUES(?,'x',NULL,'')",
                [i],
            )
            .unwrap();
        }
        db.execute(
            "DELETE FROM audit WHERE id < (SELECT COALESCE(MAX(id),0)-? FROM audit)",
            [AUDIT_MAX_ROWS],
        )
        .unwrap();
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM audit").unwrap(),
            AUDIT_MAX_ROWS + 1
        );
        assert_eq!(
            count(&db, "SELECT MAX(at) FROM audit").unwrap(),
            AUDIT_MAX_ROWS + 24
        );
    }

    #[test]
    fn age_choices_and_bounds_are_validated() {
        assert!(valid_age(None) && valid_age(Some(1)) && valid_age(Some(3650)));
        assert!(!valid_age(Some(0)) && !valid_age(Some(-5)) && !valid_age(Some(3651)));
        assert!(AGE_CHOICES.contains(&0) && AGE_CHOICES.contains(&90));
    }
}
