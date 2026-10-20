use crate::{App, management, security::*};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use hickory_proto::{
    op::{Message, MessageType, OpCode, ResponseCode},
    rr::{DNSClass, RecordType, rdata::opt::EdnsCode},
};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    env,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream, UdpSocket},
    sync::Semaphore,
    time::timeout,
};

#[derive(Clone)]
pub struct Config {
    pub upstream: SocketAddr,
    pub bind: SocketAddr,
}
impl Config {
    pub fn from_env() -> Result<Option<Self>, Box<dyn std::error::Error>> {
        let ip = env::var("BUNGEE_DNS_UPSTREAM_IP").unwrap_or_default();
        if ip.is_empty() {
            return Ok(None);
        }
        let ip: IpAddr = ip
            .parse()
            .map_err(|_| "DNS upstream must be a numeric resolver IP")?;
        let port: u16 = env::var("BUNGEE_DNS_UPSTREAM_PORT")
            .unwrap_or("53".into())
            .parse()?;
        if !valid_upstream(ip) || port == 0 {
            return Err(
                "DNS upstream must be an explicit unicast resolver outside the phone tunnel subnet"
                    .into(),
            );
        }
        let bind: SocketAddr = env::var("BUNGEE_DNS_BIND")
            .unwrap_or("10.77.0.1:5353".into())
            .parse()?;
        if !bind.ip().is_loopback() && bind.ip().to_string() != "10.77.0.1" {
            return Err("DNS must bind only to the WireGuard address or loopback".into());
        }
        if bind == SocketAddr::new(ip, port) {
            return Err("DNS upstream cannot point back to itself".into());
        }
        Ok(Some(Self {
            upstream: SocketAddr::new(ip, port),
            bind,
        }))
    }
}
fn valid_upstream(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            !v.is_unspecified()
                && !v.is_multicast()
                && !v.is_broadcast()
                && !v.is_link_local()
                && v.octets()[0] != 0
                && v.octets()[0] < 224
                && v.octets()[..3] != [10, 77, 0]
                && v.octets() != [127, 0, 0, 11]
        }
        IpAddr::V6(v) => {
            !v.is_unspecified()
                && !v.is_multicast()
                && !v.is_unicast_link_local()
                && v.to_ipv4_mapped().is_none()
        }
    }
}
pub async fn start(app: App) -> Result<(), Box<dyn std::error::Error>> {
    let Some(config) = app.dns.clone() else {
        return Ok(());
    };
    let udp = Arc::new(UdpSocket::bind(config.bind).await?);
    let tcp = TcpListener::bind(config.bind).await?;
    let slots = Arc::new(Semaphore::new(64));
    let udp_app = app.clone();
    let udp_slots = slots.clone();
    tokio::spawn(async move {
        let mut buffer = [0u8; 4097];
        while let Ok((len, peer)) = udp.recv_from(&mut buffer).await {
            if len > 4096 {
                continue;
            }
            let Ok(slot) = udp_slots.clone().try_acquire_owned() else {
                continue;
            };
            let data = buffer[..len].to_vec();
            let socket = udp.clone();
            let app = udp_app.clone();
            tokio::spawn(async move {
                let _slot = slot;
                if let Some(response) = handle(&app, peer, &data, false).await {
                    let _ = socket.send_to(&response, peer).await;
                }
            });
        }
    });
    tokio::spawn(async move {
        while let Ok((mut socket, peer)) = tcp.accept().await {
            let Ok(slot) = slots.clone().try_acquire_owned() else {
                continue;
            };
            let app = app.clone();
            tokio::spawn(async move {
                let _slot = slot;
                let _ = timeout(Duration::from_secs(10), async {
                    // Bound persistent connections; clients can reconnect for additional queries.
                    for _ in 0..16 {
                        let len = socket.read_u16().await? as usize;
                        if !(12..=4096).contains(&len) {
                            break;
                        }
                        let mut data = vec![0; len];
                        socket.read_exact(&mut data).await?;
                        let Some(reply) = handle(&app, peer, &data, true).await else {
                            break;
                        };
                        socket.write_u16(reply.len() as u16).await?;
                        socket.write_all(&reply).await?;
                    }
                    Ok::<_, std::io::Error>(())
                })
                .await;
            });
        }
    });
    tracing::info!(bind=%config.bind,"Managed DNS listener enabled; queries are summarized locally");
    Ok(())
}
fn group(name: &str) -> String {
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    if name.ends_with("-dnsotls-ds.dnscheck.grapheneos.org")
        || name.ends_with("-dnsotls-ds.metric.gstatic.com")
    {
        return "[system DNS checks]".into();
    }
    if name.ends_with(".in-addr.arpa") || name.ends_with(".ip6.arpa") {
        return "[reverse DNS]".into();
    }
    psl::domain_str(&name)
        .unwrap_or("[local names]")
        .to_string()
}
fn error_reply(query: &Message, code: ResponseCode) -> Message {
    let mut message = Message::new();
    message
        .set_id(query.id())
        .set_message_type(MessageType::Response)
        .set_op_code(OpCode::Query)
        .set_recursion_desired(query.recursion_desired())
        .set_recursion_available(true)
        .set_response_code(code);
    if let Some(q) = query.query() {
        message.add_query(q.clone());
    }
    message
}
async fn upstream(config: &Config, query: &Message, tcp: bool) -> Result<Message, ()> {
    let mut request = query.clone();
    request.set_id(rand::random());
    if let Some(edns) = request.extensions_mut() {
        edns.set_max_payload(1232);
        edns.options_mut().remove(EdnsCode::Subnet);
    }
    let data = request.to_vec().map_err(|_| ())?;
    let exchange = async {
        let reply = if tcp {
            tcp_exchange(config.upstream, &data).await?
        } else {
            let socket = UdpSocket::bind(if config.upstream.is_ipv4() {
                "0.0.0.0:0"
            } else {
                "[::]:0"
            })
            .await
            .map_err(|_| ())?;
            socket.connect(config.upstream).await.map_err(|_| ())?;
            socket.send(&data).await.map_err(|_| ())?;
            let mut buffer = [0u8; 4097];
            let len = socket.recv(&mut buffer).await.map_err(|_| ())?;
            if len > 4096 {
                return Err(());
            }
            let reply = Message::from_vec(&buffer[..len]).map_err(|_| ())?;
            if reply.truncated() {
                tcp_exchange(config.upstream, &data).await?
            } else {
                reply
            }
        };
        if reply.id() != request.id()
            || reply.message_type() != MessageType::Response
            || reply.op_code() != OpCode::Query
            || reply.queries() != request.queries()
        {
            return Err(());
        }
        Ok(reply)
    };
    timeout(Duration::from_secs(3), exchange)
        .await
        .map_err(|_| ())?
}
async fn tcp_exchange(address: SocketAddr, data: &[u8]) -> Result<Message, ()> {
    let mut socket = TcpStream::connect(address).await.map_err(|_| ())?;
    socket.write_u16(data.len() as u16).await.map_err(|_| ())?;
    socket.write_all(data).await.map_err(|_| ())?;
    let len = socket.read_u16().await.map_err(|_| ())? as usize;
    if len < 12 {
        return Err(());
    }
    let mut data = vec![0; len];
    socket.read_exact(&mut data).await.map_err(|_| ())?;
    Message::from_vec(&data).map_err(|_| ())
}
async fn handle(app: &App, peer: SocketAddr, data: &[u8], tcp: bool) -> Option<Vec<u8>> {
    let id = {
        let db = app.db.lock().unwrap();
        management::dns_peer(&db, &peer.ip().to_string())
            .ok()
            .flatten()
    }?;
    rate_limit(app, RateClass::Dns, id.clone(), 1200).ok()?;
    let query = Message::from_vec(data).ok()?;
    if query.message_type() != MessageType::Query || query.op_code() != OpCode::Query {
        return error_reply(&query, ResponseCode::Refused).to_vec().ok();
    }
    let valid = query.queries().len() == 1
        && query.query().is_some_and(|q| {
            q.query_class() == DNSClass::IN
                && ![RecordType::AXFR, RecordType::IXFR, RecordType::ANY].contains(&q.query_type())
        });
    if !valid {
        return error_reply(&query, ResponseCode::Refused).to_vec().ok();
    }
    let question = query.query()?;
    let name = question.name().to_ascii();
    if !name.is_ascii() || name.len() > 254 {
        return None;
    }
    let mut reply = upstream(app.dns.as_ref()?, &query, tcp)
        .await
        .unwrap_or_else(|_| error_reply(&query, ResponseCode::ServFail));
    // Recheck after the network wait: revocation/withdrawal must not log or answer a stale request.
    {
        let db = app.db.lock().unwrap();
        if management::dns_peer(&db, &peer.ip().to_string())
            .ok()
            .flatten()
            .as_deref()
            != Some(&id)
        {
            return None;
        }
        record(
            &db,
            &id,
            &group(&name),
            question.query_type(),
            reply.response_code(),
        )
        .ok()?;
    }
    reply.set_id(query.id());
    let limit = query
        .extensions()
        .as_ref()
        .map(|e| e.max_payload())
        .unwrap_or(512)
        .clamp(512, 1232) as usize;
    let data = reply.to_vec().ok()?;
    if !tcp && data.len() > limit {
        reply = error_reply(&query, reply.response_code());
        reply.set_truncated(true);
        return reply.to_vec().ok();
    }
    Some(data)
}
fn record(
    db: &rusqlite::Connection,
    id: &str,
    domain: &str,
    kind: RecordType,
    code: ResponseCode,
) -> rusqlite::Result<()> {
    let at = now();
    let window = at / 10;
    let a = i32::from(kind == RecordType::A);
    let aaaa = i32::from(kind == RecordType::AAAA);
    let https = i32::from([RecordType::HTTPS, RecordType::SVCB].contains(&kind));
    db.execute("INSERT INTO dns_summary VALUES(?,?,?,1,1,?,?,?, ?,?,?, ?,?,?,?)
        ON CONFLICT(device_id,bucket,domain) DO UPDATE SET queries=queries+1,
        activities=activities+CASE WHEN last_window<excluded.last_window THEN 1 ELSE 0 END,
        last_window=MAX(last_window,excluded.last_window),last_at=MAX(last_at,excluded.last_at),
        answers=answers+excluded.answers,nxdomain=nxdomain+excluded.nxdomain,errors=errors+excluded.errors,
        a=a+excluded.a,aaaa=aaaa+excluded.aaaa,https=https+excluded.https,other=other+excluded.other",
        params![id,at/300*300,domain,window,at,at,i32::from(code==ResponseCode::NoError),i32::from(code==ResponseCode::NXDomain),i32::from(![ResponseCode::NoError,ResponseCode::NXDomain].contains(&code)),a,aaaa,https,1-a-aaaa-https])?;
    Ok(())
}
#[derive(Deserialize)]
pub struct Range {
    from: i64,
    to: i64,
}
pub async fn summary(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(range): Query<Range>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    if range.from < 0 || range.to < range.from || range.to - range.from > 31 * 86400 {
        return Err(bad("Choose an ordered range of up to 31 days"));
    }
    let db = app.db.lock().unwrap();
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM devices WHERE id=?)",
        [&id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(Error(StatusCode::NOT_FOUND, "Device not found"));
    }
    let mut q=db.prepare("SELECT domain,SUM(queries),SUM(activities),MIN(first_at),MAX(last_at),SUM(answers),SUM(nxdomain),SUM(errors),SUM(a),SUM(aaaa),SUM(https),SUM(other)
        FROM dns_summary WHERE device_id=? AND bucket>=? AND bucket<=? GROUP BY domain ORDER BY SUM(activities) DESC,domain LIMIT 100")?;
    let records=q.query_map(params![id,range.from/300*300,range.to/300*300],|r|Ok(json!({"domain":r.get::<_,String>(0)?,"queries":r.get::<_,i64>(1)?,"activities":r.get::<_,i64>(2)?,"first_at":r.get::<_,i64>(3)?,"last_at":r.get::<_,i64>(4)?,"answers":r.get::<_,i64>(5)?,"nxdomain":r.get::<_,i64>(6)?,"errors":r.get::<_,i64>(7)?,"types":{"A":r.get::<_,i64>(8)?,"AAAA":r.get::<_,i64>(9)?,"HTTPS":r.get::<_,i64>(10)?,"other":r.get::<_,i64>(11)?}})))?.collect::<Result<Vec<_>,_>>()?;
    let totals:(i64,i64,i64)=db.query_row("SELECT COALESCE(SUM(queries),0),COALESCE(SUM(activities),0),COUNT(DISTINCT domain) FROM dns_summary WHERE device_id=? AND bucket>=? AND bucket<=?",params![id,range.from/300*300,range.to/300*300],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    Ok(Json(
        json!({"records":records,"queries":totals.0,"activities":totals.1,"domains":totals.2,"from":range.from/300*300,"to":(range.to/300*300).saturating_add(299),"resolution_seconds":300,"configured":app.dns.is_some()}),
    ))
}
pub async fn erase(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_admin(&app, &headers)?;
    let db = app.db.lock().unwrap();
    db.execute("DELETE FROM dns_summary WHERE device_id=?", [&id])?;
    crate::store::audit(&db, "dns.erased", Some(&id), "DNS summaries erased")?;
    Ok(Json(json!({"erased":true})))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grouping_discards_random_subdomains_and_bundles_private_suffixes_correctly() {
        assert_eq!(
            group("tracking-123.metrics.Example.CO.UK."),
            "example.co.uk"
        );
        assert_eq!(group("random.site.github.io."), "site.github.io");
        assert_eq!(
            group("random-dnsotls-ds.dnscheck.grapheneos.org."),
            "[system DNS checks]"
        );
        assert_eq!(group("1.0.0.127.in-addr.arpa."), "[reverse DNS]");
    }
    #[test]
    fn resolver_targets_exclude_loops_and_non_unicast_addresses() {
        for ip in [
            "10.77.0.1",
            "127.0.0.11",
            "0.0.0.0",
            "::",
            "169.254.169.254",
            "ff02::1",
        ] {
            assert!(!valid_upstream(ip.parse().unwrap()));
        }
        for ip in [
            "1.1.1.1",
            "8.8.8.8",
            "192.168.1.53",
            "127.0.0.1",
            "fd00::53",
            "2606:4700:4700::1111",
        ] {
            assert!(valid_upstream(ip.parse().unwrap()));
        }
    }
}
