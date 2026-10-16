use crate::{App, security::*};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize, Clone)]
pub struct HistoryQuery {
    pub(crate) from: i64,
    pub(crate) to: i64,
    pub(crate) before: Option<i64>,
    pub(crate) limit: Option<usize>,
    pub(crate) kind: Option<String>,
    pub(crate) every: Option<i64>,
    pub(crate) daily: Option<String>,
    pub(crate) timezone: Option<String>,
    pub(crate) tolerance: Option<i64>,
}
impl HistoryQuery {
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
    require_admin(&app, &headers)?;
    let limit = query.limit.unwrap_or(200);
    let (kind, recurrence) = query.selection()?;
    let db = app.db.lock().unwrap();
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM devices WHERE id=?)",
        [&id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(Error(StatusCode::NOT_FOUND, "Device not found"));
    }
    let selected = recurrence.keys(
        &db,
        &id,
        kind,
        query.from,
        query.to,
        query.before.unwrap_or(i64::MAX),
        limit,
    )?;
    let mut rows: Vec<Value> = if let Some(keys) = selected {
        let mut result = Vec::new();
        if kind == "locations" {
            let mut q = db.prepare("SELECT observed_at,received_at,latitude,longitude,accuracy FROM location_history WHERE device_id=? AND observed_at=?")?;
            for key in keys {
                result.push(q.query_row(params![id,key], |r| Ok(json!({"observed_at":r.get::<_,i64>(0)?,"received_at":r.get::<_,i64>(1)?,"latitude":r.get::<_,f64>(2)?,"longitude":r.get::<_,f64>(3)?,"accuracy":r.get::<_,f64>(4)?})))?);
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
        let mut q = db.prepare("SELECT observed_at,received_at,latitude,longitude,accuracy FROM location_history
            WHERE device_id=? AND observed_at>=? AND observed_at<=? AND observed_at<? ORDER BY observed_at DESC LIMIT ?")?;
        q.query_map(params![id,query.from,query.to,query.before.unwrap_or(i64::MAX),limit as i64 + 1], |r| {
            Ok(json!({"observed_at":r.get::<_,i64>(0)?,"received_at":r.get::<_,i64>(1)?,
                "latitude":r.get::<_,f64>(2)?,"longitude":r.get::<_,f64>(3)?,"accuracy":r.get::<_,f64>(4)?}))
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
    Ok(Json(
        json!({"kind":kind,"records":rows,"next_before":next,"from":query.from,"to":query.to}),
    ))
}
