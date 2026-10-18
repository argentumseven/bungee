# Network topology and backend placement

These notes describe the direct-Rust deployment implemented in [PR #1](https://github.com/argentumseven/bungee/pull/1), audited at commit [`e5c6898`](https://github.com/argentumseven/bungee/commit/e5c68987784d985406832bc728c51e10c59760d9). They do not describe the released 1.1.4 Caddy deployment. The [Security page](SECURITY.md) contains the drawn topology pictures.

The drawings use a Linux/VPS host with a reachable phone UDP endpoint, a separate internal management network, Docker bridge networking and port publishing. An upstream home-router NAT, Docker IPv6 routing and userland-proxy variations are deployment-specific. They are not extra Bungee services. Bridge names and container addresses are allocated by Docker and are deliberately not invented in the drawings.

## Address and port notation

| Symbol | Meaning |
| --- | --- |
| `P` | One phone's overlay address, `10.77.0.n`, where `n` is 2–254. The phone uses `P/32`. |
| `E` | Numeric WireGuard endpoint IP reachable through the phone's existing OS network. In the drawn direct VPS deployment it is a host address. An operator's upstream NAT can make it differ from the local host address. |
| `W` | Explicitly configured WireGuard UDP port. There is no default; 51820 is rejected. |
| `B:H` | Configured **internal management** host bind address and HTTPS TCP port; never a WAN publication. The browser's exact HTTPS origin can use a hostname; it is independent of the phone's numeric WireGuard endpoint. |
| `C` | Dynamically assigned Docker-side address in the shared namespace. |
| `R:D` | The single explicitly configured DNS resolver IP and port. The external-resolver path is drawn; the default resolver port is 53. |
| `s`, `q` | Ephemeral source ports, not additional published ports. |

## Underlay and overlay

The top and bottom panels are two views of the **same** phone and server. The dashed green line expresses logical L3 reachability. It is carried inside the orange UDP path; it is not a second physical link.

The phone runs `wireguard-go` and a gVisor TCP/IP stack inside Bungee's process. `P/32` belongs to that private userspace stack. Bungee creates no Android OS WireGuard interface, VPN service, system route or system DNS setting. Its transport only dials TCP `10.77.0.1:8081`. The OS carries WireGuard's ordinary UDP socket over the phone's existing Wi-Fi, cellular or other network path. Other apps keep that existing path.

| Stage | Packet or socket | Handling |
| --- | --- | --- |
| Phone inner request | IPv4 `P:s → 10.77.0.1:8081`, TCP, HTTP | Signed device request from the app-contained stack. HTTP is not separately TLS-encrypted. |
| WireGuard transport | Outer IP, UDP to `E:W`, authenticated WireGuard payload containing the inner IPv4 packet | Encrypted by `wireguard-go`; phone/carrier NAT can change the outer source tuple. It does not change `P`. |
| Host publication | UDP host `W → C:W` | Docker port publishing/DNAT and bridge/veth transport. This occurs at the host, outside the shared Bungee namespace. |
| Namespace underlay ingress | `eth0`, local INPUT UDP `W` | Delivered to the kernel WireGuard UDP socket. |
| Decapsulation | Kernel WireGuard delivers inner packet on `wg0`, `10.77.0.1/24` | Server-side peer `AllowedIPs=P/32` binds the decrypted source to its peer. |
| Device API delivery | Local INPUT on `wg0`, TCP `8081` | Rust's socket is `10.77.0.1:8081`. The destination is local to this namespace. It does not traverse FORWARD or a second container network. |
| Reply | TCP `10.77.0.1:8081 → P:s` | Routed into `wg0`, encrypted for that peer and returned through the admitted UDP flow and host conntrack/NAT. |

The phone's WireGuard peer has `AllowedIPs=10.77.0.1/32`; the server's corresponding peer has `AllowedIPs=P/32`. The server interface's `/24` does not mean that phones share an Ethernet broadcast domain or can forward through the server to each other. WireGuard authenticates peers using their keys and mandatory per-peer PSKs; the backend additionally validates device signatures, timestamps, nonces and enrolled source addresses.

## Namespace and process boundaries

There are **two runtime containers and one shared network namespace**. The server uses `network_mode: service:gateway`. They share `eth0`, `wg0`, loopback, routes, firewall rules and socket port space. Their filesystem/process views remain distinct. `wg0` is a kernel network device in that namespace; it is not a userspace gateway service that proxies a TCP connection to Rust.

The gateway container's privileged manager installs firewall rules and configures WireGuard. The server container runs UID 10001 with no capabilities. A single Rust process serves all application sockets, the built web UI and the backend handlers:

| Service | Production bind | Backend function |
| --- | --- | --- |
| Administrator HTTPS | TCP `0.0.0.0:8443`, **bound to interface `eth0`** | Rust terminates TLS 1.3 with X25519MLKEM768, serves the built React UI and `/api/*`, and enforces actual socket-source prefixes, sessions and exact-origin controls. |
| Device HTTP | TCP `10.77.0.1:8081` | `/v1/*` handles enrollment, telemetry, command polling, acknowledgments and policy sync through the phone overlay. Responses carry commands; the server does not initiate a separate connection to a phone. |
| Optional legacy DNS | UDP and TCP `10.77.0.1:5353` | A distinct DNS socket service in the same Rust process; not an HTTP route. Disabled without an explicit resolver. |

For administration, Docker publishes only the host's internal management address `B:H → C:8443`. Packets must arrive through namespace `eth0` and pass its INPUT source-prefix ACL before Rust terminates TLS and applies its own source ACL. The TLS listener is constrained by Linux `SO_BINDTODEVICE=eth0` (`BUNGEE_ADMIN_INTERFACE`), so the wildcard IPv4 bind does not expose that listener on `wg0`. No administrator socket is reachable through the phone overlay, including packets addressed to the namespace's `eth0` IP. There is no TLS-terminating intermediary or extra TCP connection in this path. Rust uses the TCP source it actually observes and ignores forwarding headers. Docker userland proxying, IPv6 configurations and host-local connections can alter the observed source; verify the chosen deployment path rather than assuming source preservation.

All Rust services share an `App` state with a local `rusqlite` connection protected by a mutex. SQLite, WAL/SHM transaction state, telemetry, history, photos, sessions and peer secrets are local files under the encrypted host mount. There is no separate database server or database TCP listener. The diagram's database line means file I/O, not a network hop. Static web files are in the server image at `/app/web`.

## Management isolation

The phone and management zones have different entry points. `wg0` is limited to C2 and optional DNS; management uses the host's configured internal address and actual internal source prefixes. It is not a second phone-overlay role.

| Ingress | Admitted services | Excluded paths |
| --- | --- | --- |
| Phone `wg0`, IPv4 `10.77.0.0/24` | Local `10.77.0.1` TCP 8081 and, when enabled, UDP/TCP 5353 after redirect | Every other local INPUT packet is dropped before the established/related rule; no dashboard, administrator API, SSH or namespace-management access. IPv6 ingress on `wg0` is also dropped. |
| Namespace `eth0`, operator-specified internal management sources | Administrator TCP 8443, after the source ACL | Sources in the phone subnet are explicitly rejected; forwarded identity headers cannot authorize a caller. |
| Phone transit | None | Namespace FORWARD stays DROP; a phone cannot route through Bungee to host management or another network. |

Host `bind_ip` must name a single internal management address or loopback, never a wildcard or phone-overlay address. The operator defines the internal routing zone using the bind address and explicit CIDRs; private/global address classification is not an authorization mechanism. Administrator CIDRs overlapping any of `10.77.0.0/24` are refused, including broad supernets such as `10.0.0.0/8`.

The firewall first classifies `wg0`: C2 and configured DNS are accepted; everything else is dropped. Only then do the general conntrack and `eth0` administrator rules run. Rust separately binds its TLS socket to `eth0` and rejects all phone-subnet sources, even with a permissive in-memory ACL. A non-loopback standalone administrator bind requires `BUNGEE_ADMIN_INTERFACE`; selecting `wg0`, an unavailable interface or a kernel that refuses the binding fails startup. Rust still has zero Linux capabilities.

On a VPS, provision an independent management/private route or separate host-to-site management tunnel if an internal route does not already exist. It must use a distinct interface/subnet from phone `wg0`. Keep host SSH and Docker management inside that zone too. Bungee does not reconfigure those host services. Match provider/host ingress policies to the management network and publish only the phone WireGuard UDP endpoint on the public side.

## Peer control and storage planes

The dotted black lines are local configuration/file operations, not packet forwarding or RPC:

1. Rust's enrollment/peer-sync code publishes `peers.conf`, containing approved peer public keys, per-peer PSKs and `P/32` AllowedIPs, into `/state/wireguard`.
2. The host's same `gateway-peers` directory is bind-mounted at `/peers` in the gateway. Its manager reads the file and applies `wg syncconf` in its approximately three-second refresh loop.
3. The gateway's server public key and observations also pass back through this shared directory. Rust does not receive the server WireGuard private-key directory or NET_ADMIN.

| Host storage on LUKS2 | Runtime mount and access |
| --- | --- |
| `volumes/server-data` | Server `/state`, read/write; includes `bungee.sqlite3` and its transaction files. |
| `volumes/gateway-peers` | Server `/state/wireguard` and gateway `/peers`, read/write. This directory contains peer PSKs and is sensitive. |
| `volumes/gateway-private` | Gateway `/private` only, including the WireGuard server private key. |
| `volumes/tls-data/issued` | Server `/tls`, read-only leaf certificate/key material. The CA private key is not mounted into either runtime container. |

The host LUKS unlock key and age backup identity stay host-only. The storage plane is drawn separately to distinguish mount/file relationships from network interfaces. The datasets mount and host updater are omitted from the runtime packet drawing; neither introduces a phone API hop.

## Optional DNS is application forwarding

This path applies only to eligible, consenting legacy peers with the required applied policy. The current personal app's fixed HTTP transport does not emit DNS queries or install managed system DNS. Drawing this service does not imply that new enrollment enables it.

| Leg | Transport and enforcement |
| --- | --- |
| Legacy peer to local DNS service | Inner UDP/TCP `P:s → 10.77.0.1:53` arrives on `wg0`. Namespace NAT PREROUTING uses REDIRECT `53 → 5353`; INPUT admits it to Rust at `10.77.0.1:5353`. Peer/consent/policy checks gate processing. |
| Rust to resolver | Rust opens a **new** UDP/TCP socket to `R:D`. For an external resolver, its source is selected by the namespace route, normally `C:q`, and the host can apply Docker SNAT. Namespace OUTPUT permits the selected destination and port only. |
| Resolver reply and client reply | Established replies return to Rust. Rust checks peer eligibility again, then replies through the peer's original connection; conntrack reverses the local redirect and WireGuard carries the inner reply. |

UDP truncation retries TCP to the **same** resolver. There is no fallback resolver, recursive route to a provider or forwarding of the original phone packet. An empty resolver setting disables the listener and egress exception. Docker DNS `127.0.0.11` is blocked.

A private home resolver on a VPS requires a **separate operator-managed host-to-home routed tunnel** or private network, with a distinct, non-overlapping subnet/interface from Bungee's `wg0`. Route the resolver's `/32` or `/128` through it, admit only the required UDP/TCP DNS port on the home side, and supply a return route or narrowly scoped SNAT. Home can initiate the tunnel with keepalive when behind NAT. This additional tunnel is not created by configuring `R:D` and is not part of the phone overlay. See [deployment routing requirements](https://github.com/argentumseven/bungee/blob/e5c68987784d985406832bc728c51e10c59760d9/docs/DEPLOYMENT.md#vps-and-private-home-dns).

## Forwarding scope

IPv4 and IPv6 forwarding are disabled **inside the shared Bungee namespace**, whose INPUT, OUTPUT and FORWARD policies default to DROP. Local loopback, admitted inbound flows, established/related replies, required IPv6 control traffic and the optional resolver exception have explicit rules. Default-deny does not mean that replies or WireGuard encapsulation cannot leave the namespace.

Host Docker bridge forwarding, port DNAT and resolver/S2S routing are distinct host functions. The namespace's FORWARD DROP does not disable Docker's host-side forwarding path. There is no namespace rule allowing transit between phone peers or from a phone to the Internet/LAN.

## Implementation references

These links pin the audited implementation so this document remains checkable while the default branch still contains release 1.1.4:

- [Generated runtime Compose and bind mounts](https://github.com/argentumseven/bungee/blob/e5c68987784d985406832bc728c51e10c59760d9/scripts/bungee-host.py#L113); [reference Compose](https://github.com/argentumseven/bungee/blob/e5c68987784d985406832bc728c51e10c59760d9/compose.yaml).
- [Kernel interface, firewall chains, DNS redirect and peer refresh](https://github.com/argentumseven/bungee/blob/e5c68987784d985406832bc728c51e10c59760d9/deploy/wireguard/entrypoint.sh).
- [Phone userspace stack, AllowedIPs, UDP endpoint and fixed HTTP dialer](https://github.com/argentumseven/bungee/blob/e5c68987784d985406832bc728c51e10c59760d9/native/transport/transport.go); [Android tunnel validation](https://github.com/argentumseven/bungee/blob/e5c68987784d985406832bc728c51e10c59760d9/android/app/src/main/java/org/bungee/app/HomeTunnel.kt).
- [Rust shared App state, routers and listener creation](https://github.com/argentumseven/bungee/blob/e5c68987784d985406832bc728c51e10c59760d9/server/src/main.rs); [socket-source enforcement](https://github.com/argentumseven/bungee/blob/e5c68987784d985406832bc728c51e10c59760d9/server/src/security.rs).
- [Interface-bound TLS listener](https://github.com/argentumseven/bungee/blob/e5c68987784d985406832bc728c51e10c59760d9/server/src/tls.rs); [management isolation fixture](https://github.com/argentumseven/bungee/blob/e5c68987784d985406832bc728c51e10c59760d9/scripts/check-management-isolation.mjs).
- [Peer-file publication](https://github.com/argentumseven/bungee/blob/e5c68987784d985406832bc728c51e10c59760d9/server/src/enrollment.rs); [DNS sockets and upstream exchange](https://github.com/argentumseven/bungee/blob/e5c68987784d985406832bc728c51e10c59760d9/server/src/dns.rs); [SQLite/WAL initialization](https://github.com/argentumseven/bungee/blob/e5c68987784d985406832bc728c51e10c59760d9/server/src/store.rs).
