use crate::{App, security::*, store};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};

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
                ("failed_unlock", 3..) | ("local_test", 0)
            )
            || self.jpeg.len() > 16 * 1024
        {
            return Err(bad("Invalid recovery photo metadata"));
        }
        let bytes = STANDARD
            .decode(&self.jpeg)
            .map_err(|_| bad("Invalid photo encoding"))?;
        if bytes.len() > 12 * 1024 || !bounded_jpeg(&bytes) {
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
            if !(1..=640).contains(&width)
                || !(1..=640).contains(&height)
                || width * height > 307_200
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
        if recent >= 6 {
            return Err(Error(
                StatusCode::TOO_MANY_REQUESTS,
                "At most six new photos per hour",
            ));
        }
        db.execute("INSERT INTO recovery_photos(device_id,photo_id,captured_at,received_at,failed_attempts,reason,jpeg) VALUES(?,?,?,?,?,?,?)", params![id,photo.id,photo.captured_at,now(),photo.failed_attempts,photo.reason,bytes])?;
    }
    Ok(Some(photo.id.clone()))
}

fn enrolled(db: &Connection, id: &str) -> ApiResult<()> {
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM devices WHERE id=? AND revoked=0 AND public_key IS NOT NULL)",
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
    let mut q = db.prepare("SELECT sequence,photo_id,captured_at,received_at,failed_attempts,reason FROM recovery_photos WHERE device_id=? AND sequence<? ORDER BY sequence DESC LIMIT 20")?;
    let rows = q.query_map(params![id,page.before.unwrap_or(i64::MAX)], |r| Ok(json!({"sequence":r.get::<_,i64>(0)?,"id":r.get::<_,String>(1)?,"captured_at":r.get::<_,i64>(2)?,"received_at":r.get::<_,i64>(3)?,"failed_attempts":r.get::<_,u32>(4)?,"reason":r.get::<_,String>(5)?})))?.collect::<Result<Vec<_>,_>>()?;
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
    db.execute(
        "UPDATE devices SET photo_epoch=? WHERE id=?",
        params![token(), id],
    )?;
    db.execute("DELETE FROM recovery_photos WHERE device_id=?", [id])?;
    Ok(())
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
