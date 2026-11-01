//! Small, allowlisted file requests to the host worker. No provider HTTP or Docker socket.
use crate::{App, geography, security::*};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
};

fn control() -> PathBuf {
    PathBuf::from(env::var("BUNGEE_MAP_CONTROL_DIR").unwrap_or("/map-control".into()))
}
fn archive_root() -> PathBuf {
    PathBuf::from(env::var("BUNGEE_MAPS_DIR").unwrap_or("/maps".into()))
}
fn read_json(path: &std::path::Path, limit: u64) -> ApiResult<Value> {
    let file = fs::File::open(path).map_err(|error| {
        Error(
            StatusCode::SERVICE_UNAVAILABLE,
            if error.kind() == std::io::ErrorKind::PermissionDenied {
                "Map metadata permissions need repair. Run: python3 scripts/bungee-host.py repair-maps"
            } else {
                "Map host status is unavailable. Run: python3 scripts/bungee-host.py repair-maps"
            },
        )
    })?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| bad("Map status unavailable"))?;
    if bytes.len() as u64 > limit {
        return Err(bad("Map status exceeds its limit"));
    }
    serde_json::from_slice(&bytes).map_err(|_| bad("Invalid map host status"))
}
fn safe_id(value: &str) -> bool {
    (2..=48).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
pub fn installed() -> ApiResult<Value> {
    let path = archive_root().join("library.json");
    if !path.exists() {
        return Ok(json!([]));
    }
    let value = read_json(&path, 262144)?;
    let list = value["regions"]
        .as_array()
        .ok_or_else(|| bad("Invalid map library"))?;
    if list.len() > 256 {
        return Err(bad("Too many installed regions"));
    }
    Ok(Value::Array(list.iter().map(|item| json!({"revision":item["filename"],"id":item["id"],"name":item["name"],"bytes":item["bytes"],"bounds":item["bounds"],"min_zoom":0,"max_zoom":item["max_zoom"],"format":"pmtiles"})).collect()))
}
pub async fn status(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let path = control().join("status/state.json");
    if !path.exists() {
        return Ok(Json(
            json!({"enabled":false,"message":"Regional downloads require the updated guided host helper."}),
        ));
    }
    let mut state = read_json(&path, 524288)?;
    state["enabled"] = json!(true);
    if let Ok(entries) = fs::read_dir(control().join("requests")) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(id) = name.strip_suffix(".json")
                && uuid::Uuid::parse_str(id).is_ok()
            {
                state["job"] =
                    json!({"id":id,"state":"queued","message":"Waiting for the host map worker"});
                break;
            }
        }
    }
    Ok(Json(state))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Job {
    action: String,
    regions: Vec<String>,
    plan_id: Option<String>,
}
pub async fn queue(
    State(app): State<App>,
    headers: HeaderMap,
    Json(job): Json<Job>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    require_admin(&app, &headers)?;
    if !["plan", "install", "remove"].contains(&job.action.as_str())
        || job.regions.is_empty()
        || job.regions.len() > 256
        || job.regions.iter().any(|id| !safe_id(id))
    {
        return Err(bad("Choose 1–256 map regions and a supported map action"));
    }
    let state = read_json(&control().join("status/state.json"), 524288)?;
    let catalog = state[if job.action == "remove" {
        "installed"
    } else {
        "catalog"
    }]
    .as_array()
    .ok_or_else(|| bad("Region catalogue unavailable"))?;
    if job
        .regions
        .iter()
        .any(|id| !catalog.iter().any(|item| item["id"].as_str() == Some(id)))
        || job
            .regions
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != job.regions.len()
    {
        return Err(bad("Unknown or duplicate map region"));
    }
    if state["job"]["state"] == "running" {
        return Err(Error(StatusCode::CONFLICT, "A map job is already running"));
    }
    if job.action == "install"
        && (job.plan_id.is_none() || job.plan_id.as_deref() != state["last_plan"]["id"].as_str())
    {
        return Err(bad("Calculate and review download sizes first"));
    }
    let requests = control().join("requests");
    if fs::read_dir(&requests)
        .map_err(|_| bad("Map request directory unavailable"))?
        .any(|entry| entry.is_ok_and(|e| e.file_name().to_string_lossy().ends_with(".json")))
    {
        return Err(Error(
            StatusCode::CONFLICT,
            "A map request is already queued",
        ));
    }
    rate_limit(&app, RateClass::AdminAggregate, "map-jobs".into(), 12)?;
    let id = uuid::Uuid::new_v4().to_string();
    let path = requests.join(format!("{id}.json"));
    let bytes = serde_json::to_vec(
        &json!({"action":job.action,"regions":job.regions,"plan_id":job.plan_id}),
    )
    .unwrap();
    // Publish only complete small requests. The root worker opens with O_NOFOLLOW
    // and independently validates IDs against its bundled catalogue.
    let temporary = requests.join(format!(".{id}.tmp"));
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, &path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
        return Err(bad("Could not queue map job"));
    }
    crate::store::audit(&app.db.lock().unwrap(), "maps.queued", None, &job.action)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"id":id,"state":"queued"})),
    ))
}
pub async fn cancel(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    if uuid::Uuid::parse_str(&id).is_err() {
        return Err(bad("Invalid map job"));
    }
    let state = read_json(&control().join("status/state.json"), 524288)?;
    let queued = control()
        .join("requests")
        .join(format!("{id}.json"))
        .is_file();
    if !queued && state["job"]["id"] == id && state["job"]["state"] != "running" {
        return Ok(Json(
            json!({"cancel_requested":false,"already_finished":true}),
        ));
    }
    if !queued && (state["job"]["id"] != id || state["job"]["state"] != "running") {
        return Err(bad("This map job is not queued or running"));
    }
    let path = control().join("requests").join(format!("cancel-{id}"));
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file
            .sync_all()
            .map_err(|_| bad("Could not save map cancellation"))?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(bad("Could not request map cancellation")),
    }
    Ok(Json(json!({"cancel_requested":true})))
}
pub async fn archive(
    State(app): State<App>,
    Path(id): Path<String>,
    request: axum::extract::Request,
) -> ApiResult<axum::response::Response> {
    require_admin(&app, request.headers())?;
    if !safe_id(&id) {
        return Err(bad("Invalid map region"));
    }
    let value = read_json(&archive_root().join("library.json"), 262144)?;
    let item = value["regions"]
        .as_array()
        .and_then(|regions| regions.iter().find(|item| item["id"] == id))
        .ok_or(Error(StatusCode::NOT_FOUND, "Map region is not installed"))?;
    let filename = item["filename"]
        .as_str()
        .ok_or_else(|| bad("Map archive unavailable"))?;
    if filename.len() > 100
        || filename.contains("..")
        || !filename.ends_with(".pmtiles")
        || !filename
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
    {
        return Err(bad("Invalid map archive name"));
    }
    geography::serve_vector(&archive_root().join("archives").join(filename), request).await
}
