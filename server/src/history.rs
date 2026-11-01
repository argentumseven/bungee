use crate::{App, security::*};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use rusqlite::{Connection, OpenFlags, params};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
static READERS: Semaphore = Semaphore::const_new(2);
const READ_TIME: Duration = Duration::from_secs(5);
struct CancelRead(Arc<AtomicBool>);
impl Drop for CancelRead {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize, Clone)]
pub struct HistoryQuery {
    pub(crate) from: i64,
    pub(crate) to: i64,
    pub(crate) before: Option<i64>,
    pub(crate) limit: Option<usize>,
    pub(crate) kind: Option<String>,
    pub(crate) source: Option<String>,
    pub(crate) every: Option<i64>,
    pub(crate) daily: Option<String>,
    pub(crate) timezone: Option<String>,
    pub(crate) tolerance: Option<i64>,
}
impl HistoryQuery {
    pub(crate) fn source_filter(&self) -> ApiResult<String> {
        match self.source.as_deref() {
            None | Some("all") => Ok(String::new()),
            Some(v)
                if ["passive", "homing", "haste", "best_guess"].contains(&v)
                    && self.kind.as_deref().unwrap_or("locations") == "locations" =>
            {
                Ok(format!(" AND source='{v}'"))
            }
            _ => Err(bad("Choose a GPS collection source or all records")),
        }
    }
    pub(crate) fn selection(&self) -> ApiResult<(&str, crate::recurrence::Recurrence)> {
        if self.from < 0
            || self.to < self.from
            || !(1..=1000).contains(&self.limit.unwrap_or(200))
            || self.before.is_some_and(|v| v <= 0)
        {
            return Err(bad(
                "Use an ordered Unix-second range and a limit from 1 to 1000",
            ));
        }
        let kind = self.kind.as_deref().unwrap_or("locations");
        if !["locations", "network", "state"].contains(&kind) {
            return Err(bad("Unknown history kind"));
        }
        self.source_filter()?;
        let recurrence = crate::recurrence::Recurrence {
            every: self.every,
            daily: self.daily.clone(),
            timezone: self.timezone.clone(),
            tolerance: self.tolerance,
        };
        recurrence.validate(self.from, self.to)?;
        Ok((kind, recurrence))
    }
}
pub async fn history(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<HistoryQuery>,
) -> ApiResult<Json<Value>> {
    query.selection()?;
    let revision = crate::export::live_revision(&app, &headers, &id)?;
    let permit = READERS.try_acquire().map_err(|_| {
        Error(
            StatusCode::TOO_MANY_REQUESTS,
            "Two history queries are running; retry shortly",
        )
    })?;
    let cancel = CancelRead(Arc::new(AtomicBool::new(false)));
    let stop = cancel.0.clone();
    let deadline = Instant::now() + READ_TIME;
    let task = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let result = read_history(
            &app,
            &headers,
            &id,
            &query,
            revision,
            stop.clone(),
            deadline,
        );
        if stop.load(Ordering::Relaxed) || Instant::now() >= deadline {
            return Err(Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "History query time limit reached; choose a smaller range",
            ));
        }
        result
    });
    tokio::time::timeout(READ_TIME, task)
        .await
        .map_err(|_| {
            Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "History query time limit reached; choose a smaller range",
            )
        })?
        .map_err(|_| Error(StatusCode::INTERNAL_SERVER_ERROR, "History worker failed"))?
}
fn read_history(
    app: &App,
    headers: &HeaderMap,
    id: &str,
    query: &HistoryQuery,
    revision: i64,
    stop: Arc<AtomicBool>,
    deadline: Instant,
) -> ApiResult<Json<Value>> {
    let limit = query.limit.unwrap_or(200);
    let (kind, recurrence) = query.selection()?;
    let db = Connection::open_with_flags(
        app.state_dir.join("bungee.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.busy_timeout(Duration::from_millis(250))?;
    db.execute_batch(
        "PRAGMA query_only=ON; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; BEGIN DEFERRED;",
    )?;
    db.progress_handler(
        2000,
        Some(move || stop.load(Ordering::Relaxed) || Instant::now() >= deadline),
    );
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM devices WHERE id=? AND revoked=0)",
        [id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(Error(StatusCode::NOT_FOUND, "Device not found"));
    }
    let filter = query.source_filter()?;
    let selected = recurrence.keys_filtered(
        &db,
        id,
        kind,
        query.from,
        query.to,
        query.before.unwrap_or(i64::MAX),
        limit,
        &filter,
    )?;
    let mut rows: Vec<Value> = if let Some(keys) = selected {
        let mut result = Vec::new();
        if kind == "locations" {
            let mut q = db.prepare("SELECT observed_at,received_at,latitude,longitude,accuracy,source,samples,system_vpn FROM location_history WHERE device_id=? AND observed_at=?")?;
            for key in keys {
                result.push(q.query_row(params![id,key], |r| Ok(json!({"observed_at":r.get::<_,i64>(0)?,"received_at":r.get::<_,i64>(1)?,"latitude":r.get::<_,f64>(2)?,"longitude":r.get::<_,f64>(3)?,"accuracy":r.get::<_,f64>(4)?,"source":r.get::<_,String>(5)?,"samples":r.get::<_,u32>(6)?,"system_vpn":r.get::<_,Option<bool>>(7)?})))?);
            }
        } else if kind == "network" {
            let mut q = db.prepare("SELECT observed_at,received_at,ip,geoip FROM network_history WHERE device_id=? AND observed_at=?")?;
            for key in keys {
                result.push(q.query_row(params![id, key], crate::geography::record)?);
            }
        } else {
            let mut q = db.prepare("SELECT id,received_at,battery,charging,device_owner FROM state_history WHERE device_id=? AND id=?")?;
            for key in keys {
                result.push(q.query_row(params![id,key], |r| Ok(json!({"id":r.get::<_,i64>(0)?,"received_at":r.get::<_,i64>(1)?,"battery":r.get::<_,u8>(2)?,"charging":r.get::<_,bool>(3)?,"device_owner":r.get::<_,bool>(4)?})))?);
            }
        }
        result
    } else if kind == "locations" {
        let mut q = db.prepare(&format!("SELECT observed_at,received_at,latitude,longitude,accuracy,source,samples,system_vpn FROM location_history WHERE device_id=? AND observed_at>=? AND observed_at<=? AND observed_at<? {filter} ORDER BY observed_at DESC LIMIT ?"))?;
        q.query_map(params![id,query.from,query.to,query.before.unwrap_or(i64::MAX),limit as i64 + 1], |r| {
            Ok(json!({"observed_at":r.get::<_,i64>(0)?,"received_at":r.get::<_,i64>(1)?,
                "latitude":r.get::<_,f64>(2)?,"longitude":r.get::<_,f64>(3)?,"accuracy":r.get::<_,f64>(4)?,"source":r.get::<_,String>(5)?,"samples":r.get::<_,u32>(6)?,"system_vpn":r.get::<_,Option<bool>>(7)?}))
        })?.collect::<Result<Vec<_>,_>>()?
    } else if kind == "network" {
        let mut q = db.prepare("SELECT observed_at,received_at,ip,geoip FROM network_history WHERE device_id=? AND observed_at>=? AND observed_at<=? AND observed_at<? ORDER BY observed_at DESC LIMIT ?")?;
        q.query_map(
            params![
                id,
                query.from,
                query.to,
                query.before.unwrap_or(i64::MAX),
                limit as i64 + 1
            ],
            crate::geography::record,
        )?
        .collect::<Result<Vec<_>, _>>()?
    } else {
        let mut q = db.prepare("SELECT id,received_at,battery,charging,device_owner FROM state_history
            WHERE device_id=? AND received_at>=? AND received_at<=? AND id<? ORDER BY id DESC LIMIT ?")?;
        q.query_map(params![id,query.from,query.to,query.before.unwrap_or(i64::MAX),limit as i64 + 1], |r| {
            Ok(json!({"id":r.get::<_,i64>(0)?,"received_at":r.get::<_,i64>(1)?,"battery":r.get::<_,u8>(2)?,
                "charging":r.get::<_,bool>(3)?,"device_owner":r.get::<_,bool>(4)?}))
        })?.collect::<Result<Vec<_>,_>>()?
    };
    let more = rows.len() > limit;
    rows.truncate(limit);
    let next = if more {
        rows.last()
            .and_then(|r| r[if kind != "state" { "observed_at" } else { "id" }].as_i64())
    } else {
        None
    };
    if crate::export::live_revision(app, headers, id)? != revision {
        return Err(Error(
            StatusCode::CONFLICT,
            "History changed; retry the query",
        ));
    }
    Ok(Json(
        json!({"kind":kind,"records":rows,"next_before":next,"from":query.from,"to":query.to}),
    ))
}
