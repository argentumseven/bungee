use axum_server::tls_rustls::RustlsConfig;
use std::{env, fs::File, io::BufReader, sync::Arc};

pub fn listener(
    address: std::net::SocketAddr,
) -> Result<std::net::TcpListener, Box<dyn std::error::Error>> {
    let interface = env::var("BUNGEE_ADMIN_INTERFACE").ok();
    if !address.ip().is_loopback() && interface.is_none() {
        return Err("BUNGEE_ADMIN_INTERFACE is required for non-loopback administration".into());
    }
    let socket = if address.is_ipv4() {
        tokio::net::TcpSocket::new_v4()?
    } else {
        tokio::net::TcpSocket::new_v6()?
    };
    if let Some(interface) = interface {
        bind_interface(&socket, &interface)?;
    }
    socket.set_reuseaddr(true)?;
    socket.bind(address)?;
    Ok(socket.listen(1024)?.into_std()?)
}

#[cfg(target_os = "linux")]
fn bind_interface(socket: &tokio::net::TcpSocket, interface: &str) -> std::io::Result<()> {
    use std::{ffi::CString, os::fd::AsRawFd};
    if interface.is_empty() || interface == "wg0" || interface.len() >= libc::IFNAMSIZ {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "BUNGEE_ADMIN_INTERFACE must name the management interface, never phone wg0",
        ));
    }
    let interface = CString::new(interface)?;
    // Linux permits first-time interface binding on an unbound, unprivileged socket.
    // Fail closed on kernels/security policies that refuse it; never add capabilities.
    // SAFETY: the fd belongs to socket; the NUL-terminated name and its length are valid.
    let result = unsafe {
        libc::setsockopt(
            socket.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_BINDTODEVICE,
            interface.as_ptr().cast(),
            interface.as_bytes_with_nul().len() as libc::socklen_t,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn bind_interface(_: &tokio::net::TcpSocket, _: &str) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Interface-bound administration requires Linux",
    ))
}

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
