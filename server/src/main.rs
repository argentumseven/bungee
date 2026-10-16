mod api;
mod security;
mod store;

use axum::{
    Router, middleware,
    routing::{delete, get, post},
};
use std::{
    env, fs,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
pub struct App {
    db: Arc<Mutex<rusqlite::Connection>>,
    origin: String,
    secure_cookie: bool,
    admin_hash: String,
    limiter: Arc<Mutex<security::RateLimits>>,
    state_dir: PathBuf,
    wg_endpoint: Option<String>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter("bungee_server=info")
        .init();
    let dir = PathBuf::from(env::var("BUNGEE_STATE_DIR").unwrap_or(".state".into()));
    fs::create_dir_all(&dir)?;
    security::private_dir(&dir)?;
    let origin = env::var("BUNGEE_PUBLIC_ORIGIN").unwrap_or("http://127.0.0.1:8080".into());
    let secure_cookie = origin.starts_with("https://");
    let admin_bind: SocketAddr = env::var("BUNGEE_ADMIN_BIND")
        .unwrap_or("127.0.0.1:8080".into())
        .parse()?;
    if !secure_cookie
        && (!admin_bind.ip().is_loopback() || !origin.starts_with("http://127.0.0.1:"))
    {
        return Err("Non-loopback dashboards require an HTTPS BUNGEE_PUBLIC_ORIGIN".into());
    }
    let password_file = env::var_os("BUNGEE_ADMIN_PASSWORD_FILE")
        .map(PathBuf::from)
        .unwrap_or(dir.join("admin-password"));
    if !password_file.exists() {
        security::private_write(&password_file, security::token().as_bytes())?;
        tracing::info!(path = %password_file.display(), "Generated admin password file; read it locally. Password is never logged.");
    }
    let password = fs::read_to_string(&password_file)?;
    if password.trim().len() < 16 {
        return Err("Admin password must be at least 16 characters".into());
    }
    let db_path = dir.join("bungee.sqlite3");
    let db = store::open(&db_path)?;
    security::private_file(&db_path)?;
    let app = App {
        db: Arc::new(Mutex::new(db)),
        origin,
        secure_cookie,
        admin_hash: security::password_hash(password.trim())
            .map_err(|_| "Password hashing failed")?,
        limiter: Arc::new(Mutex::new(security::RateLimits::default())),
        state_dir: dir,
        wg_endpoint: env::var("BUNGEE_WG_ENDPOINT").ok(),
    };
    // Expire sessions across restarts, including snapshots of the development machine.
    app.db.lock().unwrap().execute("DELETE FROM sessions", [])?;
    let housekeeping = app.clone();
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            timer.tick().await;
            if let Err(e) = api::housekeeping(&housekeeping) {
                tracing::error!(error=%e.1, "Retention or peer synchronization failed");
            }
        }
    });
    let dist = env::var("BUNGEE_WEB_DIR").unwrap_or("web/dist".into());
    let admin = Router::new()
        .route("/healthz", get(api::health))
        .route(
            "/api/session",
            get(api::session).post(api::login).delete(api::logout),
        )
        .route("/api/devices", get(api::devices))
        .route("/api/enrollments", post(api::create_enrollment))
        .route("/api/devices/{id}", delete(api::revoke))
        .route("/api/devices/{id}/location", delete(api::clear_location))
        .route("/api/devices/{id}/commands", post(api::command))
        .route("/api/audit", get(api::audit))
        .fallback_service(
            ServeDir::new(&dist).not_found_service(ServeFile::new(format!("{dist}/index.html"))),
        )
        .layer(middleware::from_fn_with_state(
            app.clone(),
            security::browser_guard,
        ))
        .layer(axum::extract::DefaultBodyLimit::max(32 * 1024))
        .with_state(app.clone());
    let device = Router::new()
        .route("/healthz", get(api::health))
        .route("/v1/enroll", post(api::enroll))
        .route("/v1/telemetry", post(api::telemetry))
        .route("/v1/commands", post(api::poll))
        .route("/v1/ack", post(api::ack))
        .layer(axum::extract::DefaultBodyLimit::max(32 * 1024))
        .with_state(app);
    let device_bind = env::var("BUNGEE_DEVICE_BIND").unwrap_or("127.0.0.1:8081".into());
    let admin_listener = tokio::net::TcpListener::bind(admin_bind).await?;
    let device_listener = tokio::net::TcpListener::bind(&device_bind).await?;
    tracing::info!(%admin_bind, %device_bind, "Bungee listening; admin and device APIs are separate");
    tokio::try_join!(
        axum::serve(
            admin_listener,
            admin.into_make_service_with_connect_info::<SocketAddr>()
        )
        .with_graceful_shutdown(shutdown()),
        axum::serve(
            device_listener,
            device.into_make_service_with_connect_info::<SocketAddr>()
        )
        .with_graceful_shutdown(shutdown()),
    )?;
    Ok(())
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}
