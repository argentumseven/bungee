mod api;
mod credentials;
mod dns;
mod enrollment;
mod export;
mod geography;
mod history;
mod management;
mod photos;
mod recurrence;
mod release;
mod security;
mod store;
mod tls;

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
    admin_networks: Vec<ipnet::IpNet>,
    limiter: Arc<Mutex<security::RateLimits>>,
    state_dir: PathBuf,
    wg_endpoint: Option<String>,
    dns: Option<dns::Config>,
    geography: Arc<geography::Geography>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("--check-geodata") {
        println!("{}", geography::Geography::load()?.status);
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    // SAFETY: PR_SET_DUMPABLE takes a scalar flag and no pointers.
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if std::env::args().nth(1).as_deref() == Some("--hash-admin-password") {
        let password = credentials::read_password()?;
        println!(
            "{}",
            security::password_hash(&password).map_err(|_| "Password hashing failed")?
        );
        return Ok(());
    }
    tracing_subscriber::fmt()
        .with_env_filter("bungee_server=info")
        .init();
    let dir = PathBuf::from(env::var("BUNGEE_STATE_DIR").unwrap_or(".state".into()));
    fs::create_dir_all(&dir)?;
    security::private_dir(&dir)?;
    let origin = env::var("BUNGEE_PUBLIC_ORIGIN").unwrap_or("http://127.0.0.1:8080".into());
    let secure_cookie = origin.starts_with("https://");
    let device_bind =
        security::device_bind(&env::var("BUNGEE_DEVICE_BIND").unwrap_or("127.0.0.1:8081".into()))?;
    let admin_bind =
        security::admin_bind(&env::var("BUNGEE_ADMIN_BIND").unwrap_or("127.0.0.1:8080".into()))?;
    let admin_networks = security::admin_networks(secure_cookie)?;
    if !secure_cookie && !admin_bind.ip().is_loopback() {
        return Err("Plain HTTP is limited to loopback development".into());
    }
    if env::var("BUNGEE_TRUST_LOOPBACK_PROXY").as_deref() == Ok("true") {
        return Err("Proxy trust is no longer supported; connect directly to Rust HTTPS".into());
    }
    if !secure_cookie && !origin.starts_with("http://127.0.0.1:") {
        return Err("Use an HTTPS BUNGEE_PUBLIC_ORIGIN for direct Rust TLS".into());
    }
    if env::var_os("BUNGEE_ADMIN_PASSWORD_FILE").is_some() {
        return Err("BUNGEE_ADMIN_PASSWORD_FILE is retired; set the administrator password with the host password command".into());
    }
    let db_path = dir.join("bungee.sqlite3");
    let db = store::open(&db_path)?;
    security::private_file(&db_path)?;
    if std::env::args().nth(1).as_deref() == Some("--set-admin-password") {
        let password = credentials::read_password()?;
        let hash = security::password_hash(&password).map_err(|_| "Password hashing failed")?;
        credentials::replace(&db, &hash)?;
        credentials::initialize(&db, &dir)?;
        println!("Administrator password changed. All sessions signed out.");
        return Ok(());
    }
    credentials::initialize(&db, &dir)?;
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
        admin_networks,
        limiter: Arc::new(Mutex::new(security::RateLimits::default())),
        state_dir: dir,
        wg_endpoint,
        dns,
        geography: Arc::new(geography::Geography::load()?),
    };
    // Expire sessions across restarts, including snapshots of the development machine.
    app.db.lock().unwrap().execute("DELETE FROM sessions", [])?;
    let housekeeping = app.clone();
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            timer.tick().await;
            if let Err(e) = geography::collect(&housekeeping) {
                tracing::error!(error=%e.1, "Network observation failed");
            }
            if let Err(e) = enrollment::housekeeping(&housekeeping) {
                tracing::error!(error=%e.1, "Retention or peer synchronization failed");
            }
        }
    });
    let dist = env::var("BUNGEE_WEB_DIR").unwrap_or("web/dist".into());
    let admin = Router::new()
        .route("/healthz", get(api::health))
        .route("/api/password", post(api::change_password))
        .route(
            "/api/session",
            get(api::session).post(api::login).delete(api::logout),
        )
        .route("/api/geography", get(geography::status))
        .route("/api/maps/{z}/{x}/{y}", get(geography::tile))
        .route("/api/devices", get(api::devices))
        .route("/api/enrollments", post(enrollment::create_enrollment))
        .route("/api/devices/{id}", delete(api::revoke))
        .route("/api/devices/{id}/location", delete(api::clear_location))
        .route(
            "/api/devices/{id}/history",
            get(history::history).delete(api::clear_history),
        )
        .route("/api/devices/{id}/commands", post(api::command))
        .route(
            "/api/devices/{id}/photos",
            get(photos::list).delete(photos::erase),
        )
        .route("/api/devices/{id}/photos/{photo}", get(photos::image))
        .route("/api/devices/{id}/history.csv", get(export::history_csv))
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
        .layer(middleware::from_fn_with_state(
            app.clone(),
            security::device_source_guard,
        ))
        .layer(axum::extract::DefaultBodyLimit::max(32 * 1024))
        .with_state(app.clone());
    dns::start(app).await?;

    let device_listener = tokio::net::TcpListener::bind(device_bind).await?;
    tracing::info!(%admin_bind, %device_bind, "Bungee listening; admin and device APIs are separate");
    let admin_server = async {
        if secure_cookie {
            let config = tls::load().await?;
            let handle = axum_server::Handle::new();
            let shutdown_handle = handle.clone();
            tokio::spawn(async move {
                shutdown().await;
                shutdown_handle.graceful_shutdown(Some(std::time::Duration::from_secs(10)));
            });
            axum_server::from_tcp_rustls(tls::listener(admin_bind)?, config)
                .handle(handle)
                .serve(admin.into_make_service_with_connect_info::<SocketAddr>())
                .await?;
        } else {
            let listener = tokio::net::TcpListener::bind(admin_bind).await?;
            axum::serve(
                listener,
                admin.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(shutdown())
            .await?;
        }
        Ok::<(), Box<dyn std::error::Error>>(())
    };
    let device_server = async {
        axum::serve(
            device_listener,
            device.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(shutdown())
        .await?;
        Ok::<(), Box<dyn std::error::Error>>(())
    };
    tokio::try_join!(admin_server, device_server)?;
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
