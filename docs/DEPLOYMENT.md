# Deployment and enrollment

Install Bungee as a removable personal app. Device-owner enrollment and persistent restrictions are disabled under the [recovery requirements](SAFETY.md). Do not assign ownership through ADB or enterprise provisioning.

## Host and network requirements

Use Linux with kernel WireGuard, Docker Compose v2, working IPv4/IPv6 iptables/conntrack support inside a NET_ADMIN container, encrypted persistent storage, and encrypted backups. A firewall setup error fails closed. The cloud development machine builds the images but cannot create a kernel WireGuard interface and has no /dev/net/tun; real phone/tunnel verification is still required.

Choose an unused UDP port yourself. **There is no default, and 51820 is rejected by the gateway, server endpoint validation, and Android client.** A different port does not replace cryptographic protection. Match BUNGEE_WG_PORT to your host's UDP port and BUNGEE_WG_ENDPOINT to the externally reachable numeric IP:port (IPv6 uses [IP]:port). Forward that chosen UDP port on your router when using public IPv4. DNS endpoint resolution is intentionally disabled; update the endpoint and re-provision if your home address changes. An authenticated endpoint-update flow remains future work.

Wireshark analyzes packets; WireGuard creates an encrypted tunnel. Neither gives a CGNAT home connection a reachable public listener. A reachable public IPv4 address, correctly firewalled IPv6 path, or an end-to-end-encrypted relay is still required for away-from-home use. No relay mode is implemented. Personal app-contained mode can coexist with a mesh VPN, but the endpoint still must be reachable numerically through that network; it is not an automatic relay or discovery integration. Android always-on is disabled.

## Direct HTTPS deployment

Use [the host installer](INSTALL.md) to provision LUKS2 storage, root-only host unlock/backup keys, local TLS certificates and mount-before-Docker boot ordering. Rust serves the administrator dashboard/API directly using TLS 1.3 X25519MLKEM768. No reverse proxy or load balancer is required. Trust the public local CA after verifying its fingerprint through an authenticated channel. There is no public ACME contact or port 80 listener.

Choose the exact internal HTTPS origin/port and administrator source prefixes. Bind host HTTPS publication to the internal management address only; it must not be WAN-published. The separately reachable WireGuard UDP endpoint is for phones. The gateway and Rust enforce management prefixes using the actual TCP source; forwarding headers are ignored. Wildcard/phone-subnet host management binds and administrator prefixes overlapping `10.77.0.0/24` are rejected.

Server `wg0` allows only phone C2 TCP `10.77.0.1:8081`. Other local ingress is dropped before established/related rules, so existing administrator sessions cannot survive a policy change through that interface. Rust HTTPS is additionally bound to namespace `eth0` with `SO_BINDTODEVICE`, and its HTTP guard rejects phone-overlay sources. Even addressing `eth0` from a phone cannot reach administration. The two containers still share a namespace; interface-specific admission supplies the separation. See [installation policy](INSTALL.md#operations-and-reboot).

## Container boundary and storage

The WireGuard gateway and Rust share a network namespace. Rust runs as UID 10001, with zero capabilities and a read-only root. The gateway has NET_ADMIN, CHOWN and DAC_OVERRIDE. Both have no-new-privileges, disabled core limits and tmpfs scratch storage. Runtime containers never receive the Docker socket, host unlock key or backup identity. Rust receives the leaf TLS key read-only; the local CA private key stays host-only.

All persistent sensitive paths live on the dedicated encrypted mount: SQLite and WAL, photos/history, administrator password, server WireGuard private key, peer PSKs/configuration, certificate keys and backups. The gateway private-key directory is not mounted into Rust. `crypttab`/`fstab` unlock with a root-only host key. Both entries use `nofail` so the host can boot if Bungee storage is unavailable; Docker still requires that exact encrypted mount before automatic container restarts. Debian installations require the `systemd-cryptsetup` boot component as well as the `cryptsetup` command. Host operations reject an unmounted or wrong storage source. Unencrypted swap is refused. Cold backups stream directly to age ciphertext; all archives authenticate before restoration changes current data. Read [the key/recovery limits](INSTALL.md#updates-encrypted-backups-and-recovery-keys), especially the limits of a host-stored key on a VPS.

Gateway IPv4/IPv6 INPUT, OUTPUT and FORWARD default to DROP. There is no general phone traffic forwarding. Replies to admitted connections and necessary IPv6 control traffic remain permitted. New outbound application connections are blocked. Docker provider DNS stays blocked.

## VPS management routing

Use a minimal patched VPS with trusted hypervisor/provider, SSH keys, a restricted SSH source policy, console recovery and a provider/host firewall matching the administrator prefixes. Route the phone WireGuard UDP port to Bungee; route HTTPS only through the separate internal management network. If the VPS lacks that path, provision a private routed network or separate host-to-site management tunnel first. Never use the phone `wg0` for server management. Restrict SSH and Docker management to that internal zone too; these host services are not configured by the Bungee installer. Do not expose either internal API port. Check the TCP source actually observed through the host's Docker/NAT path; Rust does not trust a header to restore an address hidden by a proxy. Configure Docker IPv6 routing explicitly if using IPv6 administration. For localhost/SSH access, Docker may present the host bridge address as the TCP source; allow that exact host address if needed and verify it locally. Do not widen the rule to all container addresses.

## Pairing and upgrade

1. The phone generates its own WireGuard key pair and non-exportable Android Keystore P-256 signing key. Copy its public WireGuard key into Add a device in the trusted dashboard.
2. The server generates a unique OS-random **256-bit preshared key** and a separate random one-use ten-minute invitation. It approves the peer and assigns its private /32 address.
3. The version-2 QR contains the endpoint, public keys, phone address, fixed API route, device ID, invitation and long-lived preshared secret. Transfer it directly from the trusted display to the phone. Keep it out of cloud clipboards, photos, messages and logs.
4. The phone verifies its public-key match, mandatory PSK, exact /32 route and numeric custom-port endpoint, starts its app-contained userspace transport without taking the Android VPN slot, and establishes WireGuard with the PSK.
5. Inside the tunnel it redeems the invitation and proves possession of the signing key. The server verifies the tunnel source and binds that key. Subsequent requests are signed, timestamped and nonce-protected. Invitation expiry is only for first enrollment; the paired device does not expire while offline.

Default personal mode sends only Bungee's fixed home API through an app-contained WireGuard/TCP stack, with no OS VPN routes. The current app exposes no Android VPN service and installs no always-on policy. Bungee does not configure or relay system DNS. Older managed modes are unsupported. See [mode selection and device ownership](MANAGEMENT.md).

**Upgrading from alpha.1/alpha.2:** existing checkpoints migrate into history; overwritten historical positions cannot be recovered. Legacy peers have no PSK and are blocked after this server upgrade. Their saved data remains visible; dashboard settings flag that re-pairing is required. For a personal installation, install the new app and reset only its Bungee identity, then generate a new invitation. CI debug signatures can require uninstalling the old personal APK first. If any old device ownership exists, do not uninstall or discard identity; follow the legacy recovery guide instead. Use **Reconnect · keep history** on the saved device to retain its GPS/IP history and photos. **Disconnect · keep history** preserves an offline archive; the separate erase option deliberately deletes data. For in-place personal-app updates, use the persistent server-signed APK from manager Settings → Phone app updates. Device-owner provisioning is unsupported; do not attempt it with any APK.

WireGuard PSK protection and hybrid TLS key exchange do not make all signatures post-quantum. Read [the cryptographic limits](SECURITY.md#post-quantum-protection-and-limits) before making security claims.

## History and privacy controls

Start sharing visibly and grant precise GPS permission. The app uses GPS_PROVIDER only, with no network-location fallback or Play services. GPS availability/accuracy depends on the device, sky view, permissions and OS. OS-managed assisted GNSS or other system traffic must be configured separately in GrapheneOS; app GPS requests cannot guarantee the entire OS never contacts a service provider.

The phone collects about once per minute before attempting the network and encrypts up to 10,080 unique unsent fixes locally. It retries adaptive, bounded batches after reconnect, with commands/receipts taking priority; the oldest unsent points roll off at that bound. Pausing preserves the queue; turning location sharing off clears it. Recovery resume after first unlock is opt-in; force-stop/OS restrictions can prevent operation. A powered-off phone cannot collect new fixes.

History in the dashboard queries inclusive local-time ranges with all/interval/daily recurrence, plots loaded GPS points using optional same-origin OpenStreetMap raster tiles, and exports CSV with UTC observation/receipt times. Device check-ins separately expose battery, charging and management-mode history by receipt time. The API uses Unix-second from/to parameters, limit 1..1000, and an exclusive next_before cursor; kind=locations and kind=network (separate IP/GeoIP observations) order by observation time and kind=state orders by receipt ID. Old backfills do not replace a newer last-known point.

Settings → Erase saved history clears GPS history, check-in logs and the last-known point while preserving pairing and current battery state. A cutoff blocks older queued/cached GPS data from restoring erased history; genuinely new fixes can appear while sharing continues. The legacy DELETE /api/devices/{id}/location route clears all GPS points/checkpoint but retains check-in logs. Revoke clears both histories, management policy/reports, telemetry, pending commands and the PSK, and removes tunnel access. Do not revoke a missing phone you want to keep reporting.

## Administrator credential rotation

Choose the administrator password privately during installation. Only a salted
Argon2id verifier is stored in the private SQLite database on encrypted storage.
Change it in **Settings → Administrator password** using the current password,
or reset it from the host with `sudo python3 /opt/bungee/bungee-host.py password`.
Both invalidate all browser sessions without restarting the server.

Existing local `admin-password` files migrate once and are removed after the
verifier commits; old snapshots are not rewritten. `BUNGEE_ADMIN_PASSWORD_FILE`
is retired and explicitly rejected. Manual/development deployments must initialize
a credential with the server's `--set-admin-password` command using a dedicated
stdin pipe; missing credentials fail startup instead of generating plaintext.

## Optional management

See [MANAGEMENT.md](MANAGEMENT.md) for supported personal operation, local recovery, stable signing and legacy ownership limitations.

## Image builds behind a TLS proxy

Use the host installer on an ordinary deployment host. In a development environment with a TLS-inspecting proxy, Docker may need an explicit proxy hostname mapping and the environment's CA for build-time HTTPS. `scripts/docker-build-cloud.sh` derives the proxy hostname/address without reading credential values, forwards existing proxy bindings using Docker’s predefined build arguments, and supplies the system CA bundle as a BuildKit secret. It never disables TLS/package signature checks and does not install the cloud CA into runtime images.

`scripts/docker-build-cloud.sh` builds both runtime development image tags. It does not deploy or expose them. Host-generated local certificates, encrypted storage and the complete Compose stack still require the host prerequisites above.

Local OpenStreetMap/GeoIP datasets and import/recovery/licensing instructions are in [GEOGRAPHY.md](GEOGRAPHY.md). These are read-only offline files; no external map or GeoIP lookup is permitted by the runtime egress policy.

For protocol upgrades, update the server before the phone app. See [DDIL.md](DDIL.md) for backoff, queue metrics, authenticated-contact versus telemetry time, clock requirements and delayed command-receipt reconciliation. No additional port or provider is required.

DNS routing and relay support were removed in 1.1.17. See [upgrade cleanup](DNS-REMOVAL.md) for phones that used the retired feature.
