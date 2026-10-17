# Deployment and enrollment

Install Bungee as a removable personal app. Device-owner enrollment and persistent restrictions are disabled under the [recovery requirements](SAFETY.md). Do not assign ownership through ADB or enterprise provisioning.

## Host and network requirements

Use Linux with kernel WireGuard, Docker Compose v2, working IPv4/IPv6 iptables/conntrack support inside a NET_ADMIN container, encrypted persistent storage, and encrypted backups. A firewall setup error fails closed. The cloud development machine builds the images but cannot create a kernel WireGuard interface and has no /dev/net/tun; real phone/tunnel verification is still required.

Choose an unused UDP port yourself. **There is no default, and 51820 is rejected by the gateway, server endpoint validation, and Android client.** A different port does not replace cryptographic protection. Match BUNGEE_WG_PORT to your host's UDP port and BUNGEE_WG_ENDPOINT to the externally reachable numeric IP:port (IPv6 uses [IP]:port). Forward that chosen UDP port on your router when using public IPv4. DNS endpoint resolution is intentionally disabled; update the endpoint and re-provision if your home address changes. An authenticated endpoint-update flow remains future work.

Wireshark analyzes packets; WireGuard creates an encrypted tunnel. Neither gives a CGNAT home connection a reachable public listener. A reachable public IPv4 address, correctly firewalled IPv6 path, or an end-to-end-encrypted relay is still required for away-from-home use. No relay mode is implemented. Personal app-contained mode can coexist with a mesh VPN, but the endpoint still must be reachable numerically through that network; it is not an automatic relay or discovery integration. Managed system DNS / Android always-on is disabled in the current app.

## Private dashboard deployment

Use the [guided installer](INSTALL.md) for prompted ports, mandatory administrator networks and the host update timer. The following manual alternative does not install automatic updates.

1. Copy .env.example to .env and choose BUNGEE_WG_PORT and BUNGEE_WG_ENDPOINT explicitly. Use an IP address or locally resolved dashboard name for BUNGEE_DOMAIN.
2. Set BUNGEE_ADMIN_PORT, the exact BUNGEE_PUBLIC_ORIGIN (including a nonstandard port), and mandatory BUNGEE_ADMIN_SUBNETS. Set BUNGEE_ADMIN_ADDRESS to the server's LAN address to make HTTPS available to administrator devices on that LAN. Its default is 127.0.0.1; loopback requires a local browser or an SSH tunnel with correct origin/host handling. There is no dashboard WAN-forwarding requirement. Prefer keeping administration on a trusted LAN.
3. The web image bundles its Caddy configuration. Run `docker compose up --build -d`, then check health and logs. Never publish internal API ports 8080/8081.
4. Caddy creates and renews certificates with its **local CA**. Retrieve only the public root: `docker compose exec -T web cat /data/caddy/pki/authorities/local/root.crt > bungee-root.crt`. Verify its SHA-256 fingerprint locally/over an authenticated channel, then explicitly trust it on administrator devices. Never export root.key or disable verification. CA trust grants certificate authority; use an administrator browser/profile under your control.
5. Use a current browser supporting TLS 1.3 **X25519MLKEM768**. The server rejects classical-only key exchange; there is no automatic fallback. Read the generated administrator password locally with `docker compose exec server cat /state/admin-password` and sign in to the exact HTTPS origin.

There is **no public ACME/certificate-provider contact**, port 80 listener, HTTP/3 listener, cloud push, remote map/geocoding service, analytics or in-app runtime update check. The optional host updater downloads release artifacts as described in INSTALL.md. Only the chosen dashboard HTTPS TCP port on the chosen bind address and the custom WireGuard UDP port are published. Do not add a third-party TLS-terminating proxy if the provider must not see data.

## Container boundary and volumes

The gateway owns one network namespace shared by Rust and Caddy. Rust's administrator listener and Caddy upstream use loopback; the device API binds only 10.77.0.1:8081. Gateway firewall policy drops newly initiated external connections, including Docker provider-DNS requests, except the explicitly configured private home DNS upstream IP/port. It permits responses to inbound phone/dashboard connections. Essential IPv6 control traffic remains permitted. IP forwarding stays disabled. Rust runs as UID 10001 with zero capabilities and a read-only root filesystem. Caddy has only NET_BIND_SERVICE; gateway has NET_ADMIN, CHOWN and DAC_OVERRIDE.

| Volume | Access | Contains |
| --- | --- | --- |
| server-data | Rust only | SQLite history, per-device preshared secrets, administrator password |
| gateway-private | Gateway only | Server WireGuard private key |
| gateway-peers | Rust + gateway | Server public key and approved /32 peers with secret preshared keys |
| caddy-data/config | Caddy only | Local CA private keys, certificates and configuration state |

Back up application state coherently while Rust is stopped, or use SQLite's online backup API plus a coherent key/peer backup. Do not copy a live database without its transaction state. Caddy CA material also requires an encrypted backup; replacing the CA requires updating administrator trust. Backups retain erased history until the backup expires. Test restoration in isolation and monitor disk capacity: server GPS/check-in history has no automatic eviction.

## Pairing and upgrade

1. The phone generates its own WireGuard key pair and non-exportable Android Keystore P-256 signing key. Copy its public WireGuard key into Add a device in the trusted dashboard.
2. The server generates a unique OS-random **256-bit preshared key** and a separate random one-use ten-minute invitation. It approves the peer and assigns its private /32 address.
3. The version-2 QR contains the endpoint, public keys, phone address, fixed API route, device ID, invitation and long-lived preshared secret. Transfer it directly from the trusted display to the phone. Keep it out of cloud clipboards, photos, messages and logs.
4. The phone verifies its public-key match, mandatory PSK, exact /32 route and numeric custom-port endpoint, starts its app-contained userspace transport without taking the Android VPN slot, and establishes WireGuard with the PSK.
5. Inside the tunnel it redeems the invitation and proves possession of the signing key. The server verifies the tunnel source and binds that key. Subsequent requests are signed, timestamped and nonce-protected. Invitation expiry is only for first enrollment; the paired device does not expire while offline.

Default personal mode sends only Bungee's fixed home API through an app-contained WireGuard/TCP stack, with no OS VPN routes. The current app exposes no Android VPN service and installs no system DNS/always-on policy. Older managed modes are unsupported. See [mode selection, private DNS and device ownership](MANAGEMENT.md).

**Upgrading from alpha.1/alpha.2:** existing checkpoints migrate into history; overwritten historical positions cannot be recovered. Legacy peers have no PSK and are blocked after this server upgrade. Their saved data remains visible; dashboard settings flag that re-pairing is required. For a personal installation, install the new app and reset only its Bungee identity, then generate a new invitation. CI debug signatures can require uninstalling the old personal APK first. If any old device ownership exists, do not uninstall or discard identity; follow the legacy recovery guide instead. Export any needed legacy data before revoking that old server identity: revocation intentionally erases it. For in-place personal-app updates, use a stable signing identity. Device-owner provisioning is unsupported; do not attempt it with any APK.

WireGuard PSK protection and hybrid TLS key exchange do not make all signatures post-quantum. Read [the cryptographic limits](SECURITY.md#post-quantum-protection-and-limits) before making security claims.

## History and privacy controls

Start sharing visibly and grant precise GPS permission. The app uses GPS_PROVIDER only, with no network-location fallback or Play services. GPS availability/accuracy depends on the device, sky view, permissions and OS. OS-managed assisted GNSS or other system traffic must be configured separately in GrapheneOS; app GPS requests cannot guarantee the entire OS never contacts a service provider.

The phone collects about once per minute before attempting the network and encrypts up to 10,080 unique unsent fixes locally. It retries adaptive, bounded batches after reconnect, with commands/receipts taking priority; the oldest unsent points roll off at that bound. Pausing preserves the queue; turning location sharing off clears it. Recovery resume after first unlock is opt-in; force-stop/OS restrictions can prevent operation. A powered-off phone cannot collect new fixes.

History in the dashboard queries inclusive local-time ranges with all/interval/daily recurrence, plots loaded GPS points using optional same-origin OpenStreetMap raster tiles, and exports CSV with UTC observation/receipt times. Device check-ins separately expose battery, charging and management-mode history by receipt time. The API uses Unix-second from/to parameters, limit 1..1000, and an exclusive next_before cursor; kind=locations and kind=network (separate IP/GeoIP observations) order by observation time and kind=state orders by receipt ID. Old backfills do not replace a newer last-known point.

Settings → Erase saved history clears GPS history, check-in logs and the last-known point while preserving pairing and current battery state. A cutoff blocks older queued/cached GPS data from restoring erased history; genuinely new fixes can appear while sharing continues. The legacy DELETE /api/devices/{id}/location route clears all GPS points/checkpoint but retains check-in logs. Revoke clears both histories, DNS summaries, management policy/reports, telemetry, pending commands and the PSK, and removes tunnel access. Do not revoke a missing phone you want to keep reporting.

## Administrator credential rotation

The server reads the password file at startup and keeps an Argon2id verifier in memory. Stop Rust, replace /state/admin-password securely with a high-entropy password of at least 16 characters (UID 10001, mode 0600), then restart. Sessions invalidate on restart. Alternatively mount a private file through BUNGEE_ADMIN_PASSWORD_FILE; keep its value out of source, Compose YAML and logs.

## Optional management and home DNS

See [MANAGEMENT.md](MANAGEMENT.md) for supported personal operation, local recovery, stable signing and legacy ownership limitations. Leave the legacy DNS upstream unset for new deployments; new managed-DNS policies are refused.

## Image builds behind a TLS proxy

Use the README's Compose build on an ordinary host. In a development environment with a TLS-inspecting proxy, Docker may need an explicit proxy hostname mapping and the environment's CA for build-time HTTPS. `scripts/docker-build-cloud.sh` derives the proxy hostname/address without reading credential values, forwards existing proxy bindings using Docker’s predefined build arguments, and supplies the system CA bundle as a BuildKit secret. It never disables TLS/package signature checks and does not install the cloud CA into runtime images.

`scripts/docker-build-cloud.sh` builds all three local development image tags. It does not deploy or expose them. Live Caddy certificate issuance and the complete Compose stack still require the host prerequisites above.

Local OpenStreetMap/GeoIP datasets and import/recovery/licensing instructions are in [GEOGRAPHY.md](GEOGRAPHY.md). These are read-only offline files; no external map or GeoIP lookup is permitted by the runtime egress policy.

For protocol upgrades, update the server before the phone app. See [DDIL.md](DDIL.md) for backoff, queue metrics, authenticated-contact versus telemetry time, clock requirements and delayed command-receipt reconciliation. No additional port or provider is required.
