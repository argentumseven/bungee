use crate::{App, security::*, store};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};

pub const MAX_JPEG_BYTES: usize = 1024 * 1024;
pub const MAX_PENDING: u32 = 8;
const MAX_BASE64_CHARS: usize = MAX_JPEG_BYTES.div_ceil(3) * 4;
const MAX_NEW_PER_HOUR: u32 = 20 + MAX_PENDING; // Current attempts plus an offline queue catching up.
static UPLOADS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

pub async fn admission(request: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let Ok(_permit) = UPLOADS.try_acquire() else {
        return Error(
            StatusCode::TOO_MANY_REQUESTS,
            "Two photo uploads are running; retry shortly",
        )
        .into_response();
    };
    match tokio::time::timeout(std::time::Duration::from_secs(75), next.run(request)).await {
        Ok(response) => response,
        Err(_) => Error(
            StatusCode::REQUEST_TIMEOUT,
            "Photo upload exceeded its time limit",
        )
        .into_response(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Upload {
    photo_epoch: String,
    photo: Photo,
}

pub async fn upload(
    State(app): State<App>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let id = verify_device(&app, &headers, "/v1/photos", &body)?;
    let input: Upload = serde_json::from_slice(&body).map_err(|_| bad("Invalid photo upload"))?;
    let bytes = input.photo.validate()?;
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    crate::runtime::fence(&tx, &id, &headers)?;
    let accepted = commit(&tx, &id, Some(&input.photo_epoch), &input.photo, &bytes)?;
    let epoch: String = tx.query_row("SELECT photo_epoch FROM devices WHERE id=?", [&id], |r| {
        r.get(0)
    })?;
    tx.commit()?;
    Ok(Json(
        json!({"accepted_photo":accepted,"photo_epoch":epoch,"server_time":now()}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Photo {
    pub id: String,
    pub captured_at: i64,
    pub failed_attempts: u32,
    pub reason: String,
    pub jpeg: String,
}
impl Photo {
    pub fn validate(&self) -> ApiResult<Vec<u8>> {
        if uuid::Uuid::parse_str(&self.id).is_err()
            || self.id.len() != 36
            || self.captured_at <= 0
            || self.captured_at > now() + 120
            || !matches!(
                (self.reason.as_str(), self.failed_attempts),
                ("failed_unlock", 3..) | ("local_test" | "remote_manual", 0)
            )
            || self.jpeg.len() > MAX_BASE64_CHARS
        {
            return Err(bad("Invalid recovery photo metadata"));
        }
        let bytes = STANDARD
            .decode(&self.jpeg)
            .map_err(|_| bad("Invalid photo encoding"))?;
        if bytes.len() > MAX_JPEG_BYTES || !bounded_jpeg(&bytes) {
            return Err(bad("Expected a bounded JPEG without EXIF"));
        }
        Ok(bytes)
    }
}

// No image decoder runs on the server. Check framing, bounded dimensions and absence
// of EXIF/IPTC before serving bytes only as image/jpeg under nosniff and no-store.
fn bounded_jpeg(b: &[u8]) -> bool {
    if b.len() < 12 || !b.starts_with(&[0xff, 0xd8]) || !b.ends_with(&[0xff, 0xd9]) {
        return false;
    }
    let mut offset = 2;
    let mut dimensions = false;
    let mut scan = false;
    while offset + 1 < b.len() {
        if b[offset] != 0xff {
            return false;
        }
        while offset < b.len() && b[offset] == 0xff {
            offset += 1;
        }
        let Some(&marker) = b.get(offset) else {
            return false;
        };
        offset += 1;
        if marker == 0xd9 {
            return dimensions && scan && offset == b.len();
        }
        if offset + 2 > b.len() {
            return false;
        }
        let length = u16::from_be_bytes([b[offset], b[offset + 1]]) as usize;
        if length < 2 || offset + length > b.len() {
            return false;
        }
        if !matches!(marker, 0xc0 | 0xc2 | 0xc4 | 0xdb | 0xdd | 0xda | 0xe0 | 0xe2..=0xec | 0xee..=0xef)
        {
            return false;
        }
        if matches!(marker, 0xc0 | 0xc2) {
            if dimensions || length < 8 || b[offset + 2] != 8 {
                return false;
            }
            let height = u16::from_be_bytes([b[offset + 3], b[offset + 4]]) as u32;
            let width = u16::from_be_bytes([b[offset + 5], b[offset + 6]]) as u32;
            let components = b[offset + 7] as usize;
            if !(1..=2048).contains(&width)
                || !(1..=2048).contains(&height)
                || width * height > 3_145_728
                || ![1, 3].contains(&components)
                || length != 8 + 3 * components
            {
                return false;
            }
            dimensions = true;
        }
        if matches!(marker, 0x00 | 0xd8 | 0xd9 | 0xd0..=0xd7) {
            return false;
        }
        offset += length;
        if marker == 0xda {
            if !dimensions || length < 6 {
                return false;
            }
            scan = true;
            // Scan entropy bytes only to the next unescaped marker. This checks
            // later progressive scans/metadata too, without decoding any pixels.
            while offset + 1 < b.len() {
                if b[offset] != 0xff {
                    offset += 1;
                    continue;
                }
                let start = offset;
                while offset < b.len() && b[offset] == 0xff {
                    offset += 1;
                }
                let Some(&next) = b.get(offset) else {
                    return false;
                };
                if next == 0x00 || (0xd0..=0xd7).contains(&next) {
                    offset += 1;
                } else {
                    offset = start;
                    break;
                }
            }
        }
    }
    false
}

pub fn commit(
    db: &Connection,
    id: &str,
    epoch: Option<&str>,
    photo: &Photo,
    bytes: &[u8],
) -> ApiResult<Option<String>> {
    let current: String = db
        .query_row(
            "SELECT photo_epoch FROM devices WHERE id=? AND revoked=0 AND public_key IS NOT NULL",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(denied)?;
    if epoch.is_none() {
        return Err(Error(StatusCode::CONFLICT, "Photo generation required"));
    }
    if epoch != Some(current.as_str()) {
        return Ok(None);
    }
    let erased: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM erased_photos WHERE device_id=? AND photo_id=?)",
        params![id, photo.id],
        |row| row.get(0),
    )?;
    if erased {
        return Ok(Some(photo.id.clone()));
    }
    type Stored = (i64, u32, String, Vec<u8>);
    let existing: Option<Stored> = db.query_row("SELECT captured_at,failed_attempts,reason,jpeg FROM recovery_photos WHERE device_id=? AND photo_id=?", params![id,photo.id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    if let Some((at, attempts, reason, stored)) = existing {
        if at != photo.captured_at
            || attempts != photo.failed_attempts
            || reason != photo.reason
            || stored != bytes
        {
            return Err(Error(
                StatusCode::CONFLICT,
                "Photo ID already has different content",
            ));
        }
    } else {
        let recent: u32 = db.query_row(
            "SELECT COUNT(*) FROM recovery_photos WHERE device_id=? AND received_at>?",
            params![id, now() - 3600],
            |r| r.get(0),
        )?;
        if recent >= MAX_NEW_PER_HOUR {
            return Err(Error(
                StatusCode::TOO_MANY_REQUESTS,
                "At most twenty-eight new photos per hour",
            ));
        }
        db.execute("INSERT INTO recovery_photos(device_id,photo_id,captured_at,received_at,failed_attempts,reason,jpeg) VALUES(?,?,?,?,?,?,?)", params![id,photo.id,photo.captured_at,now(),photo.failed_attempts,photo.reason,bytes])?;
    }
    Ok(Some(photo.id.clone()))
}

fn enrolled(db: &Connection, id: &str) -> ApiResult<()> {
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM devices WHERE id=?)",
        [id],
        |r| r.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(Error(StatusCode::NOT_FOUND, "Enrolled device not found"))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    before: Option<i64>,
}
pub async fn list(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(page): Query<Page>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    if page.before.is_some_and(|v| v <= 0) {
        return Err(bad("Invalid photo cursor"));
    }
    let db = app.db.lock().unwrap();
    enrolled(&db, &id)?;
    let mut q = db.prepare("SELECT p.sequence,p.photo_id,p.captured_at,p.received_at,p.failed_attempts,p.reason,p.device_id,CASE WHEN d.primary_device_id IS NULL THEN 'Main profile' ELSE d.name END FROM recovery_photos p JOIN devices d ON d.id=p.device_id WHERE (d.id=? OR d.primary_device_id=?) AND p.sequence<? ORDER BY p.sequence DESC LIMIT 20")?;
    let rows = q.query_map(params![id,id,page.before.unwrap_or(i64::MAX)], |r| Ok(json!({"sequence":r.get::<_,i64>(0)?,"id":r.get::<_,String>(1)?,"captured_at":r.get::<_,i64>(2)?,"received_at":r.get::<_,i64>(3)?,"failed_attempts":r.get::<_,u32>(4)?,"reason":r.get::<_,String>(5)?,"source_device_id":r.get::<_,String>(6)?,"profile_name":r.get::<_,String>(7)?})))?.collect::<Result<Vec<_>,_>>()?;
    let next = if rows.len() == 20 {
        rows.last().map(|r| r["sequence"].clone())
    } else {
        None
    };
    Ok(Json(json!({"photos":rows,"next_before":next})))
}
pub async fn image(
    State(app): State<App>,
    headers: HeaderMap,
    Path((id, photo)): Path<(String, String)>,
) -> ApiResult<Response> {
    require_admin(&app, &headers)?;
    let db = app.db.lock().unwrap();
    enrolled(&db, &id)?;
    let bytes: Vec<u8> = db
        .query_row(
            "SELECT jpeg FROM recovery_photos WHERE device_id=? AND photo_id=?",
            params![id, photo],
            |r| r.get(0),
        )
        .optional()?
        .ok_or(Error(StatusCode::NOT_FOUND, "Photo not found"))?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/jpeg"),
            (
                header::CONTENT_DISPOSITION,
                "inline; filename=\"bungee-recovery.jpg\"",
            ),
        ],
        bytes,
    )
        .into_response())
}
pub fn erase_in(db: &Connection, id: &str) -> ApiResult<()> {
    for member in crate::profiles::members(db, id)? {
        db.execute(
            "UPDATE devices SET photo_epoch=? WHERE id=?",
            params![token(), member],
        )?;
        db.execute("DELETE FROM recovery_photos WHERE device_id=?", [&member])?;
        db.execute("DELETE FROM erased_photos WHERE device_id=?", [&member])?;
    }
    Ok(())
}

pub async fn erase_one(
    State(app): State<App>,
    headers: HeaderMap,
    Path((id, photo)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    if uuid::Uuid::parse_str(&photo).is_err() {
        return Err(bad("Invalid photo ID"));
    }
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    enrolled(&tx, &id)?;
    tx.execute(
        "INSERT OR IGNORE INTO erased_photos(device_id,photo_id) VALUES(?,?)",
        params![id, photo],
    )?;
    tx.execute(
        "DELETE FROM recovery_photos WHERE device_id=? AND photo_id=?",
        params![id, photo],
    )?;
    store::audit(&tx, "photo.erased", Some(&id), "One recovery photo erased")?;
    tx.commit()?;
    Ok(Json(json!({"cleared":true})))
}

pub async fn list_all(
    State(app): State<App>,
    headers: HeaderMap,
    Query(page): Query<Page>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    if page.before.is_some_and(|value| value <= 0) {
        return Err(bad("Invalid photo cursor"));
    }
    let db = app.db.lock().unwrap();
    let mut q = db.prepare("SELECT p.sequence,p.photo_id,p.captured_at,p.received_at,p.failed_attempts,p.reason,COALESCE(d.primary_device_id,d.id),COALESCE(main.name,d.name),p.device_id,CASE WHEN d.primary_device_id IS NULL THEN 'Main profile' ELSE d.name END FROM recovery_photos p JOIN devices d ON d.id=p.device_id LEFT JOIN devices main ON main.id=d.primary_device_id WHERE p.sequence<? ORDER BY p.sequence DESC LIMIT 20")?;
    let rows = q.query_map([page.before.unwrap_or(i64::MAX)], |r| Ok(json!({"sequence":r.get::<_,i64>(0)?,"id":r.get::<_,String>(1)?,"captured_at":r.get::<_,i64>(2)?,"received_at":r.get::<_,i64>(3)?,"failed_attempts":r.get::<_,u32>(4)?,"reason":r.get::<_,String>(5)?,"device_id":r.get::<_,String>(6)?,"device_name":r.get::<_,String>(7)?,"source_device_id":r.get::<_,String>(8)?,"profile_name":r.get::<_,String>(9)?})))?.collect::<Result<Vec<_>,_>>()?;
    let next = if rows.len() == 20 {
        rows.last().map(|row| row["sequence"].clone())
    } else {
        None
    };
    Ok(Json(json!({"photos":rows,"next_before":next})))
}

pub async fn erase_all(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    let ids = tx
        .prepare("SELECT id FROM devices")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for id in &ids {
        erase_in(&tx, id)?;
    }
    store::audit(
        &tx,
        "photos.all_erased",
        None,
        "Recovery photos erased across devices; photo generations rotated",
    )?;
    tx.commit()?;
    Ok(Json(json!({"cleared":true})))
}
pub async fn erase(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    enrolled(&tx, &id)?;
    erase_in(&tx, &id)?;
    store::audit(
        &tx,
        "photos.erased",
        Some(&id),
        "Recovery photos erased; earlier queued generations cannot restore them",
    )?;
    tx.commit()?;
    Ok(Json(json!({"cleared":true})))
}
