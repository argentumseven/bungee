use axum_server::tls_rustls::RustlsConfig;
use std::{env, fs::File, io::BufReader, sync::Arc};

fn config() -> Result<rustls::ServerConfig, Box<dyn std::error::Error>> {
    let cert = env::var("BUNGEE_TLS_CERT_FILE")?;
    let key = env::var("BUNGEE_TLS_KEY_FILE")?;
    let certs = rustls_pemfile::certs(&mut BufReader::new(File::open(cert)?))
        .collect::<Result<Vec<_>, _>>()?;
    let key = rustls_pemfile::private_key(&mut BufReader::new(File::open(key)?))?
        .ok_or("TLS private key is missing")?;
    let mut provider = rustls::crypto::aws_lc_rs::default_provider();
    provider
        .kx_groups
        .retain(|g| g.name() == rustls::NamedGroup::X25519MLKEM768);
    if provider.kx_groups.is_empty() {
        return Err("Hybrid TLS key exchange is unavailable".into());
    }
    let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(provider))
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_no_client_auth()
        .with_single_cert(certs, key)?;
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(config)
}

pub async fn load() -> Result<RustlsConfig, Box<dyn std::error::Error>> {
    let tls = RustlsConfig::from_config(Arc::new(config()?));
    let reload = tls.clone();
    // The host renews certificates atomically. Keep serving the last valid pair
    // if a renewal is interrupted or a replacement fails validation.
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            timer.tick().await;
            match config() {
                Ok(config) => reload.reload_from_config(Arc::new(config)),
                Err(e) => tracing::error!(error=%e, "TLS certificate reload failed"),
            }
        }
    });
    Ok(tls)
}
