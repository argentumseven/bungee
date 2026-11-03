//! Optional Android Private DNS relay. Public TLS is separate from the private manager CA.
use crate::{App, security::*, store};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{env, fs::File, io::BufReader, net::SocketAddr, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Semaphore,
    time::timeout,
};
use tokio_rustls::TlsAcceptor;

#[derive(Clone)]
pub struct Config {
    pub host: String,
    bind: SocketAddr,
    cert: String,
    key: String,
}
pub fn valid_host(host: &str) -> bool {
    host.len() <= 200
        && host.contains('.')
        && host.parse::<std::net::IpAddr>().is_err()
        && host.split('.').all(|s| {
            !s.is_empty()
                && s.len() <= 63
                && !s.starts_with('-')
                && !s.ends_with('-')
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}
impl Config {
    pub fn from_env() -> Result<Option<Self>, Box<dyn std::error::Error>> {
        let host = env::var("BUNGEE_PRIVATE_DNS_HOST").unwrap_or_default();
        if host.is_empty() {
            return Ok(None);
        }
        if !valid_host(&host) {
            return Err("Private DNS needs a lowercase public DNS hostname, without a scheme, wildcard, port or IP".into());
        }
        Ok(Some(Self {
            host,
            bind: env::var("BUNGEE_PRIVATE_DNS_BIND")
                .unwrap_or("0.0.0.0:8853".into())
                .parse()?,
            cert: env::var("BUNGEE_PRIVATE_DNS_CERT_FILE")?,
            key: env::var("BUNGEE_PRIVATE_DNS_KEY_FILE")?,
        }))
    }
    fn tls(&self) -> Result<TlsAcceptor, Box<dyn std::error::Error>> {
        let certs = rustls_pemfile::certs(&mut BufReader::new(File::open(&self.cert)?))
            .collect::<Result<Vec<_>, _>>()?;
        let key = rustls_pemfile::private_key(&mut BufReader::new(File::open(&self.key)?))?
            .ok_or("Private DNS TLS key missing")?;
        // Android's resolver negotiates conventional TLS; the manager's hybrid-only CA is unrelated.
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::aws_lc_rs::default_provider(),
        ))
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(certs, key)?;
        Ok(TlsAcceptor::from(Arc::new(config)))
    }
}
#[derive(Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Report {
    pub revision: i64,
    pub state: String,
    pub active: bool,
    pub consent: bool,
    pub permission: bool,
    pub detail: String,
    pub at: i64,
}
impl Report {
    fn valid(&self) -> bool {
        self.revision >= 0
            && [
                "disabled",
                "active",
                "fallback",
                "permission_required",
                "not_approved",
                "error",
                "removed",
            ]
            .contains(&self.state.as_str())
            && self.detail.len() <= 240
            && !self.detail.chars().any(char::is_control)
            && self.at > 0
            && self.at <= now() + 120
            && (!self.active || self.state == "active")
    }
}
fn exists(db: &rusqlite::Connection, id: &str) -> ApiResult<()> {
    let active: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM devices WHERE id=?)",
        [id],
        |r| r.get(0),
    )?;
    if active {
        Ok(())
    } else {
        Err(Error(StatusCode::NOT_FOUND, "Paired phone not found"))
    }
}
pub fn desired(app: &App, db: &rusqlite::Connection, id: &str) -> ApiResult<Value> {
    let row:Option<(i64,bool,bool,bool,String,Option<String>)>=db.query_row("SELECT revision,enabled,fallback,removed,hostname,report FROM dns_profiles WHERE device_id=?",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
    let (revision, enabled, fallback, removed, hostname, report) =
        row.unwrap_or((0, false, true, false, String::new(), None));
    let configured = app.private_dns.is_some() && app.dns.is_some();
    Ok(
        json!({"revision":revision,"enabled":enabled&&configured,"requested_enabled":enabled,"fallback":fallback,"removed":removed,"hostname":hostname,"configured":configured,"service_host":app.private_dns.as_ref().map(|c|&c.host),"report":report.and_then(|s|serde_json::from_str::<Value>(&s).ok())}),
    )
}
pub async fn get(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let db = app.db.lock().unwrap();
    exists(&db, &id)?;
    Ok(Json(desired(&app, &db, &id)?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Save {
    expected_revision: i64,
    action: String,
    fallback: bool,
    #[serde(default)]
    restored_locally: bool,
}
pub async fn save(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<Save>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    if input.expected_revision < 0
        || ![
            "enable",
            "disable",
            "remove",
            "fallback",
            "confirm_restored",
        ]
        .contains(&input.action.as_str())
    {
        return Err(bad("Invalid DNS setting"));
    }
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    exists(&tx, &id)?;
    let previous = desired(&app, &tx, &id)?;
    if previous["revision"] != input.expected_revision {
        return Err(Error(
            StatusCode::CONFLICT,
            "DNS setting changed; refresh before saving",
        ));
    }
    if input.action == "confirm_restored" {
        if !input.restored_locally {
            return Err(bad(
                "Confirm DNS was restored on the phone before removing an offline profile",
            ));
        }
        tx.execute("UPDATE dns_profiles SET enabled=0,removed=1,hostname='',report=NULL,revision=revision+1 WHERE device_id=?",[&id])?;
        store::audit(
            &tx,
            "dns.local_restoration_confirmed",
            Some(&id),
            "Administrator confirmed local DNS restoration before removing the offline profile",
        )?;
        let result = desired(&app, &tx, &id)?;
        tx.commit()?;
        return Ok(Json(result));
    }
    let enabling = input.action == "enable";
    if enabling {
        let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM devices WHERE id=? AND revoked=0 AND public_key IS NOT NULL)",[&id],|r|r.get(0))?;
        if !active {
            return Err(bad("Pair the phone before enabling DNS"));
        }
    }
    if enabling && (!previous["configured"].as_bool().unwrap_or(false)) {
        return Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Set up a public Bungee DNS-over-TLS hostname and trusted wildcard certificate first",
        ));
    }
    let revision = input
        .expected_revision
        .checked_add(1)
        .ok_or_else(|| bad("DNS revision limit reached"))?;
    let old_hostname = previous["hostname"].as_str().unwrap_or("");
    let hostname = if enabling && old_hostname.is_empty() {
        format!(
            "{}.{}",
            hex::encode(rand::random::<[u8; 16]>()),
            app.private_dns.as_ref().unwrap().host
        )
    } else {
        old_hostname.to_string()
    };
    if enabling && !hostname.ends_with(&format!(".{}", app.private_dns.as_ref().unwrap().host)) {
        return Err(bad(
            "Remove the previous DNS setup on the phone before changing the service hostname",
        ));
    }
    let enabled = enabling || (input.action == "fallback" && previous["requested_enabled"] == true);
    let removed =
        input.action == "remove" || (input.action == "fallback" && previous["removed"] == true);
    tx.execute("INSERT INTO dns_profiles(device_id,revision,enabled,fallback,removed,hostname) VALUES(?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,fallback=excluded.fallback,removed=excluded.removed,hostname=excluded.hostname",params![id,revision,enabled,input.fallback,removed,hostname])?;
    store::audit(
        &tx,
        "dns.updated",
        Some(&id),
        &format!(
            "DNS {} requested; waiting for phone confirmation",
            input.action
        ),
    )?;
    let result = desired(&app, &tx, &id)?;
    tx.commit()?;
    Ok(Json(result))
}
pub async fn sync(
    State(app): State<App>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let id = verify_device(&app, &headers, "/v1/private-dns", &body)?;
    let report: Report =
        serde_json::from_slice(&body).map_err(|_| bad("Invalid private DNS report"))?;
    if !report.valid() {
        return Err(bad("Invalid private DNS report values"));
    }
    let db = app.db.lock().unwrap();
    db.execute("INSERT INTO dns_profiles(device_id,revision,enabled,fallback,removed,hostname) VALUES(?,0,0,1,0,'') ON CONFLICT(device_id) DO NOTHING",[&id])?;
    let policy = desired(&app, &db, &id)?;
    if report.revision > policy["revision"].as_i64().unwrap_or(0) {
        return Err(bad("Unknown DNS revision"));
    }
    db.execute(
        "UPDATE dns_profiles SET report=? WHERE device_id=?",
        params![serde_json::to_string(&report).unwrap(), id],
    )?;
    if !report.active
        && !report.consent
        && report.revision == policy["revision"]
        && ["disabled", "removed"].contains(&report.state.as_str())
        && policy["requested_enabled"] == true
    {
        db.execute(
            "UPDATE dns_profiles SET enabled=0,removed=?,revision=revision+1 WHERE device_id=?",
            params![report.state == "removed", id],
        )?;
    }
    // Keep the relay usable until the phone confirms restoration. Removing a profile early would break strict DNS.
    if report.state == "removed"
        && !report.active
        && report.revision == policy["revision"]
        && (policy["removed"] == true || !report.consent)
    {
        db.execute(
            "UPDATE dns_profiles SET hostname='',report=? WHERE device_id=?",
            params![serde_json::to_string(&report).unwrap(), id],
        )?;
    }
    Ok(Json(
        json!({"dns":desired(&app,&db,&id)?,"server_time":now()}),
    ))
}
pub(crate) fn peer(app: &App, host: &str) -> Option<String> {
    let config = app.private_dns.as_ref()?;
    if host.len() != config.host.len() + 33 || !host.ends_with(&format!(".{}", config.host)) {
        return None;
    }
    peer_db(&app.db.lock().unwrap(), host)
}
pub(crate) fn peer_db(db: &rusqlite::Connection, host: &str) -> Option<String> {
    let row:Option<(String,bool,i64,Option<String>)>=db.query_row("SELECT p.device_id,p.enabled,p.revision,p.report FROM dns_profiles p JOIN devices d ON d.id=p.device_id WHERE p.hostname=? AND d.revoked=0 AND d.public_key IS NOT NULL",[host],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().ok()?;
    let (id, enabled, revision, report) = row?;
    let restored = report
        .and_then(|s| serde_json::from_str::<Report>(&s).ok())
        .is_some_and(|r| {
            r.revision == revision
                && !r.active
                && ["disabled", "removed", "fallback"].contains(&r.state.as_str())
        });
    (enabled || !restored).then_some(id)
}
pub async fn start(app: App) -> Result<(), Box<dyn std::error::Error>> {
    let Some(config) = app.private_dns.clone() else {
        return Ok(());
    };
    if app.dns.is_none() {
        return Err("Private DNS needs a home DNS upstream".into());
    }
    let initial = config.tls()?;
    let current = Arc::new(std::sync::RwLock::new(initial));
    let listener = TcpListener::bind(config.bind).await?;
    let reload = current.clone();
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_secs(60));
        loop {
            timer.tick().await;
            if let Ok(new) = config.tls() {
                *reload.write().unwrap() = new;
            }
        }
    });
    let slots = Arc::new(Semaphore::new(128));
    tokio::spawn(async move {
        while let Ok((socket, address)) = listener.accept().await {
            if rate_limit(
                &app,
                RateClass::Dns,
                format!("dot-connect:{}", address.ip()),
                240,
            )
            .is_err()
            {
                continue;
            }
            let Ok(slot) = slots.clone().try_acquire_owned() else {
                continue;
            };
            let app = app.clone();
            let tls = current.read().unwrap().clone();
            tokio::spawn(async move {
                let _slot = slot;
                let Ok(Ok(mut stream)) = timeout(Duration::from_secs(5), tls.accept(socket)).await
                else {
                    return;
                };
                let Some(host) = stream.get_ref().1.server_name().map(str::to_owned) else {
                    return;
                };
                let Some(id) = peer(&app, &host) else { return };
                let _ = timeout(Duration::from_secs(120), async {
                    for _ in 0..256 {
                        let len = stream.read_u16().await? as usize;
                        if !(12..=4096).contains(&len) {
                            break;
                        }
                        let mut data = vec![0; len];
                        stream.read_exact(&mut data).await?;
                        if peer(&app, &host).as_deref() != Some(&id) {
                            break;
                        }
                        let Some(reply) =
                            crate::dns::forward_profile(&app, &id, &host, &data).await
                        else {
                            break;
                        };
                        if peer(&app, &host).as_deref() != Some(&id) {
                            break;
                        }
                        stream.write_u16(reply.len() as u16).await?;
                        stream.write_all(&reply).await?;
                    }
                    Ok::<_, std::io::Error>(())
                })
                .await;
            });
        }
    });
    Ok(())
}
