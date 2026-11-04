use crate::{App, security::*};
use axum::{
    Json,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
};

fn root() -> PathBuf {
    std::env::var_os("BUNGEE_APP_UPDATES_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| "/app-updates".into())
}
fn sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn read_descriptor(name: &str) -> Option<Value> {
    let path = root().join(name);
    if fs::metadata(&path).ok()?.len() > 8192 {
        return None;
    }
    let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    if value["version"].as_str()? != crate::release::version()
        || !sha(value["sha256"].as_str()?)
        || !sha(value["signer_sha256"].as_str()?)
        || !(1..=256 * 1024 * 1024).contains(&value["size"].as_u64()?)
        || value["version_code"].as_u64()? != crate::release::android_code()
        || fs::metadata(root().join(format!("{}.apk", value["sha256"].as_str()?)))
            .ok()?
            .len()
            != value["size"].as_u64()?
    {
        return None;
    }
    Some(value)
}
pub fn descriptor() -> Option<Value> {
    read_descriptor("release.json")
}
/// Old clients did not send their installed certificate. Keep their established
/// household identity usable until they upgrade; official clients select theirs.
pub fn for_signer(signer: Option<&str>) -> Option<Value> {
    let official = descriptor();
    let legacy = read_descriptor("legacy-release.json");
    match signer {
        Some(value)
            if official
                .as_ref()
                .is_some_and(|r| r["signer_sha256"].as_str() == Some(value)) =>
        {
            official
        }
        Some(value)
            if legacy
                .as_ref()
                .is_some_and(|r| r["signer_sha256"].as_str() == Some(value)) =>
        {
            legacy
        }
        Some(_) => official,
        None => legacy.or(official),
    }
}
pub fn preparation() -> Value {
    fs::read(root().join("status.json"))
        .ok()
        .filter(|b| b.len() <= 8192)
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .unwrap_or(json!({"state":"waiting","message":"The host is preparing this server’s APK automatically. Check the host’s bungee-app-updates.service if this persists."}))
}
pub async fn status(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    Ok(Json(
        json!({"server_version":crate::release::version(),"release":descriptor(),"preparation":preparation()}),
    ))
}
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Check {
    installed_signer_sha256: Option<String>,
}
pub async fn check(
    State(app): State<App>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    verify_device(&app, &headers, "/v1/app-update", &body)?;
    let input: Check = serde_json::from_slice(&body).map_err(|_| bad("Invalid APK check"))?;
    if input
        .installed_signer_sha256
        .as_deref()
        .is_some_and(|value| !sha(value))
    {
        return Err(bad("Invalid installed signing certificate"));
    }
    Ok(Json(
        json!({"server_version":crate::release::version(),"release":for_signer(input.installed_signer_sha256.as_deref()),"preparation":preparation(),"server_time":now()}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Chunk {
    sha256: String,
    offset: u64,
}
pub async fn chunk(
    State(app): State<App>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    verify_device(&app, &headers, "/v1/app-update/chunk", &body)?;
    let input: Chunk =
        serde_json::from_slice(&body).map_err(|_| bad("Invalid APK chunk request"))?;
    if !sha(&input.sha256)
        || input.offset > 256 * 1024 * 1024
        || !input.offset.is_multiple_of(131072)
    {
        return Err(bad("Invalid APK chunk offset"));
    }
    // Immutable names permit an in-flight download of the previous server release.
    let mut file = fs::File::open(root().join(format!("{}.apk", input.sha256))).map_err(|_| {
        Error(
            StatusCode::NOT_FOUND,
            "APK expired; check for updates again",
        )
    })?;
    let size = file.metadata()?.len();
    if size > 256 * 1024 * 1024 || input.offset >= size {
        return Err(bad("APK offset outside file"));
    }
    file.seek(SeekFrom::Start(input.offset))?;
    let mut data = vec![0u8; 131072.min((size - input.offset) as usize)];
    file.read_exact(&mut data)?;
    Ok(Json(
        json!({"sha256":input.sha256,"offset":input.offset,"data":STANDARD.encode(data)}),
    ))
}
pub async fn download(
    State(app): State<App>,
    request: axum::extract::Request,
) -> ApiResult<Response> {
    require_admin(&app, request.headers())?;
    let release = descriptor().ok_or(Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "This server’s APK is still being prepared",
    ))?;
    let mut response = tower_http::services::ServeFile::new(
        root().join(format!("{}.apk", release["sha256"].as_str().unwrap())),
    )
    .try_call(request)
    .await
    .map_err(|_| Error(StatusCode::SERVICE_UNAVAILABLE, "APK unavailable"))?
    .into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        "application/vnd.android.package-archive".parse().unwrap(),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        "attachment; filename=\"bungee.apk\"".parse().unwrap(),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    Ok(response)
}
