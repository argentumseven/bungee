mod api;
mod dns;
mod management;
mod recurrence;
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
    dns: Option<dns::Config>,
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
    let wg_endpoint = env::var("BUNGEE_WG_ENDPOINT").ok();
    if let Some(endpoint) = &wg_endpoint {
        let address: SocketAddr = endpoint.parse().map_err(|_| "BUNGEE_WG_ENDPOINT must be a literal IP:port (IPv6 uses [IP]:port); no provider DNS lookup")?;
        if address.port() == 0
            || address.port() == 51820
            || address.ip().is_unspecified()
            || address.ip().is_multicast()
        {
            return Err(
                "Choose a reachable IP and a nonzero custom WireGuard port other than 51820".into(),
            );
        }
    }
    let dns = dns::Config::from_env()?;
    let app = App {
        db: Arc::new(Mutex::new(db)),
        origin,
        secure_cookie,
        admin_hash: security::password_hash(password.trim())
            .map_err(|_| "Password hashing failed")?,
        limiter: Arc::new(Mutex::new(security::RateLimits::default())),
        state_dir: dir,
        wg_endpoint,
        dns,
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
        .route(
            "/api/devices/{id}/history",
            get(api::history).delete(api::clear_history),
        )
        .route("/api/devices/{id}/commands", post(api::command))
        .route(
            "/api/devices/{id}/policy",
            get(management::get_policy).post(management::save_policy),
        )
        .route(
            "/api/devices/{id}/dns",
            get(dns::summary).delete(dns::erase),
        )
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
        .route("/v1/sync", post(management::sync))
        .layer(axum::extract::DefaultBodyLimit::max(32 * 1024))
        .with_state(app.clone());
    dns::start(app).await?;
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
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}
