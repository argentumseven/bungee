//! Bounded CSV streaming on a separate read-only SQLite connection.
use crate::{App, history::HistoryQuery, security::*};
use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, SecondsFormat};
use futures_core::Stream;
use rusqlite::{Connection, OpenFlags, OptionalExtension, types::Value};
use std::{
    io,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
    time::{Duration, Instant},
};
use tokio::sync::{Semaphore, mpsc};

static EXPORTS: Semaphore = Semaphore::const_new(2);
const CHUNK_BYTES: usize = 32 * 1024;
const EXPORT_TIME: Duration = Duration::from_secs(300);
type ExportResult = Result<(), Box<dyn std::error::Error + Send + Sync>>;

struct CsvBody {
    receiver: mpsc::Receiver<Result<Bytes, io::Error>>,
    cancelled: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
}
impl Stream for CsvBody {
    type Item = Result<Bytes, io::Error>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.receiver.poll_recv(cx) {
            Poll::Ready(None) if self.failed.swap(false, Ordering::Relaxed) => {
                Poll::Ready(Some(Err(io::Error::other(
                    "Export interrupted; retry a smaller time range",
                ))))
            }
            other => other,
        }
    }
}
impl Drop for CsvBody {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
}

pub(crate) fn live_revision(app: &App, headers: &HeaderMap, id: &str) -> ApiResult<i64> {
    require_admin(app, headers)?;
    app.db
        .lock()
        .unwrap()
        .query_row(
            "SELECT history_revision FROM devices WHERE id=? AND revoked=0",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or(Error(StatusCode::NOT_FOUND, "Device not found"))
}
struct ExportJob {
    app: App,
    headers: HeaderMap,
    id: String,
    query: HistoryQuery,
    revision: i64,
    cancelled: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    deadline: Instant,
}
impl ExportJob {
    fn check(&self) -> io::Result<()> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(io::Error::other("Export cancelled"));
        }
        if Instant::now() >= self.deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Export time limit reached",
            ));
        }
        if live_revision(&self.app, &self.headers, &self.id).map_err(|e| io::Error::other(e.1))?
            != self.revision
        {
            return Err(io::Error::other("History changed; restart export"));
        }
        Ok(())
    }
}
fn send(
    job: &ExportJob,
    sender: &mpsc::Sender<Result<Bytes, io::Error>>,
    mut item: Result<Bytes, io::Error>,
) -> io::Result<()> {
    loop {
        job.check()?;
        match sender.try_send(item) {
            Ok(()) => return Ok(()),
            Err(mpsc::error::TrySendError::Closed(_)) => {
                return Err(io::Error::other("Export cancelled"));
            }
            Err(mpsc::error::TrySendError::Full(value)) => {
                item = value;
                std::thread::park_timeout(Duration::from_millis(50));
            }
        }
    }
}
fn timestamp(value: i64) -> rusqlite::Result<String> {
    DateTime::from_timestamp(value, 0)
        .map(|v| v.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or(rusqlite::Error::InvalidQuery)
}
fn csv_row(row: &rusqlite::Row<'_>, kind: &str) -> rusqlite::Result<String> {
    Ok(match kind {
        "locations" => format!(
            "{},{},{},{},{}\n",
            timestamp(row.get(0)?)?,
            timestamp(row.get(1)?)?,
            row.get::<_, f64>(2)?,
            row.get::<_, f64>(3)?,
            row.get::<_, f64>(4)?
        ),
        "network" => {
            let saved = row
                .get::<_, Option<String>>(3)?
                .and_then(|v| serde_json::from_str::<serde_json::Value>(&v).ok())
                .unwrap_or(serde_json::Value::Null)
                .to_string();
            format!(
                "{},{},{},\"{}\"\n",
                timestamp(row.get(0)?)?,
                timestamp(row.get(1)?)?,
                row.get::<_, String>(2)?,
                saved.replace('"', "\"\"")
            )
        }
        _ => format!(
            "{},{},{},{}\n",
            timestamp(row.get(0)?)?,
            row.get::<_, u8>(1)?,
            row.get::<_, bool>(2)?,
            row.get::<_, bool>(3)?
        ),
    })
}
fn write_csv(job: &ExportJob, sender: &mpsc::Sender<Result<Bytes, io::Error>>) -> ExportResult {
    let ExportJob {
        app,
        headers: _,
        id,
        query,
        revision: _,
        cancelled,
        failed: _,
        deadline,
    } = job;
    let (kind, recurrence) = query.selection().map_err(|e| io::Error::other(e.1))?;
    let db = Connection::open_with_flags(
        app.state_dir.join("bungee.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.busy_timeout(Duration::from_millis(500))?;
    db.execute_batch("PRAGMA query_only=ON; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE;")?;
    // Daily-slot selection and the row cursor share one read snapshot. Live
    // authorization/erasure checks deliberately use the separate app connection.
    db.execute_batch("BEGIN DEFERRED;")?;
    let stop = cancelled.clone();
    let deadline = *deadline;
    db.progress_handler(
        2000,
        Some(move || stop.load(Ordering::Relaxed) || Instant::now() >= deadline),
    );
    let (table, clock, key, columns, title) = match kind {
        "locations" => (
            "location_history",
            "observed_at",
            "observed_at",
            "observed_at,received_at,latitude,longitude,accuracy",
            "observed_at_utc,received_at_utc,latitude,longitude,accuracy_m\n",
        ),
        "network" => (
            "network_history",
            "observed_at",
            "observed_at",
            "observed_at,received_at,ip,geoip",
            "observed_at_utc,received_at_utc,ip,geoip_json\n",
        ),
        _ => (
            "state_history",
            "received_at",
            "id",
            "received_at,battery,charging,device_owner",
            "received_at_utc,battery_percent,charging,device_owner\n",
        ),
    };
    let mut bindings = vec![
        Value::Text(id.into()),
        Value::Integer(query.from),
        Value::Integer(query.to),
        Value::Integer(query.before.unwrap_or(i64::MAX)),
    ];
    let filter = if let Some(every) = recurrence.every {
        bindings.push(Value::Integer(every));
        format!(
            "AND {key} IN (SELECT MAX({key}) FROM {table} WHERE device_id=?1 AND {clock}>=?2 AND {clock}<=?3 GROUP BY ({clock}-?2)/?5)"
        )
    } else if recurrence.daily.is_some() {
        let keys = recurrence
            .keys(
                &db,
                id,
                kind,
                query.from,
                query.to,
                query.before.unwrap_or(i64::MAX),
                1000,
            )
            .map_err(|e| io::Error::other(e.1))?
            .unwrap_or_default();
        if keys.is_empty() {
            "AND 0".into()
        } else {
            let placeholders = (5..5 + keys.len())
                .map(|n| format!("?{n}"))
                .collect::<Vec<_>>()
                .join(",");
            bindings.extend(keys.into_iter().map(Value::Integer));
            format!("AND {key} IN ({placeholders})")
        }
    } else {
        String::new()
    };
    let sql = format!(
        "SELECT {columns} FROM {table} WHERE device_id=?1 AND {clock}>=?2 AND {clock}<=?3 AND {key}<?4 {filter} ORDER BY {key} DESC"
    );
    let mut statement = db.prepare(&sql)?;
    let mut rows = statement.query(rusqlite::params_from_iter(bindings))?;
    let mut chunk = String::with_capacity(CHUNK_BYTES + 1024);
    chunk.push_str(title);
    let mut since_check = 0;
    while let Some(row) = rows.next()? {
        if since_check == 0 {
            job.check()?;
        }
        chunk.push_str(&csv_row(row, kind)?);
        since_check = (since_check + 1) % 256;
        if chunk.len() >= CHUNK_BYTES {
            send(
                job,
                sender,
                Ok(Bytes::from(std::mem::replace(
                    &mut chunk,
                    String::with_capacity(CHUNK_BYTES + 1024),
                ))),
            )?;
        }
    }
    job.check()?;
    if !chunk.is_empty() {
        send(job, sender, Ok(Bytes::from(chunk)))?;
    }
    Ok(())
}
pub async fn history_csv(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<HistoryQuery>,
) -> ApiResult<Response> {
    let (kind, _) = query.selection()?;
    let revision = live_revision(&app, &headers, &id)?;
    let permit = EXPORTS.try_acquire().map_err(|_| {
        Error(
            StatusCode::TOO_MANY_REQUESTS,
            "Two exports are already running; finish or cancel one in your browser",
        )
    })?;
    let disposition = format!("attachment; filename=\"bungee-history-{kind}.csv\"");
    let cancelled = Arc::new(AtomicBool::new(false));
    let (sender, receiver) = mpsc::channel(2);
    let failed = Arc::new(AtomicBool::new(false));
    let job = ExportJob {
        app,
        headers,
        id,
        query,
        revision,
        cancelled: cancelled.clone(),
        failed: failed.clone(),
        deadline: Instant::now() + EXPORT_TIME,
    };
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if let Err(e) = write_csv(&job, &sender) {
            job.failed.store(true, Ordering::Relaxed);
            if !job.cancelled.load(Ordering::Relaxed) && !sender.is_closed() {
                tracing::warn!(error=%e,"History export did not complete");
            }
        }
    });
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8"),
            (header::CONTENT_DISPOSITION, &disposition),
        ],
        Body::from_stream(CsvBody {
            receiver,
            cancelled,
            failed,
        }),
    )
        .into_response())
}
