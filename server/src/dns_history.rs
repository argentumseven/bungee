//! Administrator DNS views. Diagnostic checks are kept separate from received traffic.
use crate::{App, security::*};
use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{Value, json};

pub const PATH_TEST: &str = "[Bungee DNS path test]";

#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    #[default]
    Traffic,
    Diagnostics,
    All,
}
impl Kind {
    fn name(&self) -> &str {
        match self {
            Self::Traffic => "traffic",
            Self::Diagnostics => "diagnostics",
            Self::All => "all",
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Filter {
    from: i64,
    to: i64,
    device_id: Option<String>,
    #[serde(default)]
    kind: Kind,
    q: Option<String>,
    #[serde(default)]
    offset: u32,
    limit: Option<u32>,
}

const FILTER: &str = "s.bucket>=?1 AND s.bucket<=?2 AND (?3 IS NULL OR s.device_id=?3)
    AND (?4='all' OR (?4='diagnostics' AND s.domain=?5) OR (?4='traffic' AND s.domain<>?5))
    AND instr(lower(s.domain),lower(?6))>0";

pub async fn summary(
    State(app): State<App>,
    headers: HeaderMap,
    Query(filter): Query<Filter>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let limit = filter.limit.unwrap_or(50);
    let q = filter.q.unwrap_or_default();
    if filter.from < 0
        || filter.to < filter.from
        || filter.to - filter.from > 31 * 86400
        || !(1..=100).contains(&limit)
        || filter.offset > 10000
        || q.len() > 254
        || q.chars().any(char::is_control)
        || filter
            .device_id
            .as_ref()
            .is_some_and(|s| s.len() > 100 || s.is_empty())
    {
        return Err(bad(
            "Choose up to 31 days, 1–100 rows, and a valid DNS filter",
        ));
    }
    let from = filter.from / 300 * 300;
    let to = filter.to / 300 * 300;
    let device = filter.device_id.as_deref();
    let kind = filter.kind.name();
    let db = app.db.lock().unwrap();
    if let Some(id) = device {
        let exists: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM devices WHERE id=?)",
            [id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(Error(StatusCode::NOT_FOUND, "Device not found"));
        }
    }
    let total_sql = format!(
        "SELECT COALESCE(SUM(queries),0),COALESCE(SUM(activities),0),COUNT(DISTINCT domain),COUNT(DISTINCT device_id),MAX(last_at) FROM dns_summary s WHERE {FILTER}"
    );
    let totals: (i64, i64, i64, i64, Option<i64>) = db.query_row(
        &total_sql,
        params![from, to, device, kind, PATH_TEST, q],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;
    let counts:(i64,i64)=db.query_row("SELECT COALESCE(SUM(CASE WHEN domain<>?4 THEN queries ELSE 0 END),0),COALESCE(SUM(CASE WHEN domain=?4 THEN queries ELSE 0 END),0) FROM dns_summary WHERE bucket>=?1 AND bucket<=?2 AND (?3 IS NULL OR device_id=?3)",params![from,to,device,PATH_TEST],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let sql=format!("SELECT domain,SUM(queries),SUM(activities),MIN(first_at),MAX(last_at),SUM(answers),SUM(nxdomain),SUM(errors),SUM(a),SUM(aaaa),SUM(https),SUM(other),COUNT(DISTINCT device_id)
        FROM dns_summary s WHERE {FILTER} GROUP BY domain ORDER BY SUM(queries) DESC,domain LIMIT ?7 OFFSET ?8");
    let mut statement = db.prepare(&sql)?;
    let records=statement.query_map(params![from,to,device,kind,PATH_TEST,q,limit+1,filter.offset],|r|Ok(json!({
        "domain":r.get::<_,String>(0)?,"queries":r.get::<_,i64>(1)?,"activities":r.get::<_,i64>(2)?,"first_at":r.get::<_,i64>(3)?,"last_at":r.get::<_,i64>(4)?,
        "answers":r.get::<_,i64>(5)?,"nxdomain":r.get::<_,i64>(6)?,"errors":r.get::<_,i64>(7)?,"types":{"A":r.get::<_,i64>(8)?,"AAAA":r.get::<_,i64>(9)?,"HTTPS":r.get::<_,i64>(10)?,"other":r.get::<_,i64>(11)?},"devices":r.get::<_,i64>(12)?
    })))?.collect::<Result<Vec<_>,_>>()?;
    let more = records.len() > limit as usize;
    let records = records.into_iter().take(limit as usize).collect::<Vec<_>>();
    let sql=format!("SELECT d.id,d.name,d.revoked,d.public_key IS NOT NULL,d.capabilities,d.management_report,d.last_contact,
        COALESCE(t.queries,0),COALESCE(t.activities,0),COALESCE(t.domains,0),t.last_at
        FROM devices d LEFT JOIN (SELECT device_id,SUM(queries) queries,SUM(activities) activities,COUNT(DISTINCT domain) domains,MAX(last_at) last_at
        FROM dns_summary s WHERE {FILTER} GROUP BY device_id) t ON t.device_id=d.id
        WHERE (?3 IS NULL OR d.id=?3) ORDER BY COALESCE(t.queries,0) DESC,d.name COLLATE NOCASE,d.id");
    let mut statement = db.prepare(&sql)?;
    let mut devices=statement.query_map(params![from,to,device,kind,PATH_TEST,q],|r|{
        let report=r.get::<_,Option<String>>(5)?.and_then(|s|serde_json::from_str::<Value>(&s).ok());
        let capabilities=serde_json::from_str::<Vec<String>>(&r.get::<_,String>(4)?).unwrap_or_default();
        let revoked=r.get::<_,bool>(2)?;
        let enrolled=r.get::<_,bool>(3)? && !revoked;
        Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"revoked":revoked,"enrolled":enrolled,
            "can_test":enrolled && capabilities.iter().any(|s|s=="dns_check"),"reported_dns":report.as_ref().and_then(|s|s.get("system_dns")),"last_contact":r.get::<_,Option<i64>>(6)?,
            "queries":r.get::<_,i64>(7)?,"activities":r.get::<_,i64>(8)?,"domains":r.get::<_,i64>(9)?,"last_at":r.get::<_,Option<i64>>(10)?}))
    })?.collect::<Result<Vec<_>,_>>()?;
    for phone in &mut devices {
        phone["private_dns"] =
            crate::private_dns::desired(&app, &db, phone["id"].as_str().unwrap())?;
    }
    Ok(Json(
        json!({"records":records,"devices":devices,"queries":totals.0,"activities":totals.1,"domains":totals.2,"phones":totals.3,"last_at":totals.4,
        "counts":{"traffic":counts.0,"diagnostics":counts.1},"from":from,"to":to.saturating_add(299),"resolution_seconds":300,"offset":filter.offset,"limit":limit,"has_more":more,"kind":kind,
        "private_dns_configured":app.private_dns.is_some(),"configured":app.dns.is_some(),"upstream":app.dns.as_ref().map(|s|s.upstream.to_string()),"phone_dns_routed":false,"routing":"app_only","server_time":now()}),
    ))
}
