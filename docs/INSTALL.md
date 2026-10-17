# Guided installation and container updates

Alpha.7 adds a local installer and transactional Compose updater. It remains a development preview under the [recovery contract](SAFETY.md). No household deployment or physical GrapheneOS validation has been performed.

## Start with a plan

Use a dedicated **Linux server with Python 3, a local Docker Engine, Compose 2.24+, systemd and kernel WireGuard support**. Install Docker using its [official instructions](https://docs.docker.com/engine/install/). The installer does not silently replace Docker, run downloaded shell code, add users to the root-equivalent Docker group or change the host firewall/router. Remote Docker contexts, Docker Desktop and systems without systemd are outside this guided installation path.

Use encrypted persistent storage and separately encrypted offline backups. Local snapshots contain history, pairing secrets and CA keys; private file permissions do not replace disk encryption. Leave room for images and an additional complete snapshot of all five volumes. Before downtime the updater estimates state size and requires snapshot space plus 20% and 1 GiB; this does not reserve disk or replace monitoring Docker storage. Primary history is never automatically trimmed.

From the inspected checkout:

```sh
bash scripts/install.sh --plan    # prompts and validates; no writes or network calls
sudo bash scripts/install.sh     # same wizard, then builds and starts the stack
```

The wizard asks for your WireGuard UDP port (no default; 51820 forbidden), dashboard HTTPS TCP port (8443 suggested), numeric endpoint reachable by phones, dashboard bind IP/browser address, administrator sources, update channel and whether to enable update checks. Loopback is the safe dashboard-bind default; choose the server's specific LAN address for LAN access. It does not discover your public IP through a provider or create router forwards. CGNAT still needs an independently reachable path.

**Administrator sources are mandatory and have no default.** Examples:

| Input | Meaning |
| --- | --- |
| `192.168.1.25` | Only that host: `192.168.1.25/32` |
| `192.168.1.25/24` | Explicitly normalized to `192.168.1.0/24` |
| `fd12:3456::25` | Only that IPv6 host: `/128` |
| `192.168.1.0/24, 10.8.0.20` | Both entries; spaces or commas separate them |

Empty, malformed, unspecified, multicast, scoped/mapped IPv6 and excessively broad networks are rejected. IPv4 needs four octets. Prefixes must be /8 or narrower for IPv4 and /16 or narrower for IPv6, with at most 32 entries. Use your actual narrow LAN/VPN subnet or host; no allow-everyone option exists.

The normalized review includes the exact HTTPS URL with your selected port. Interactive installation requires typing INSTALL. Existing installation directories, Bungee containers and Bungee volumes are refused rather than overwritten. The script checks port availability and kernel WireGuard inside an isolated disposable container before creating the installation.

All three services must become healthy before outside admission opens. The installer saves `/opt/bungee/root.crt`, prints its SHA-256 certificate fingerprint and gives the local password-reading command. Verify/trust that **local CA** over an authenticated channel on administrator devices. No public certificate issuer or TLS-verification bypass is used. Never export the CA private key. A current browser supporting X25519MLKEM768 is required.

For unattended answers, use `--config /secure/bungee.json`; all fields below are required and validated identically:

```json
{
  "wg_port": 49271,
  "web_port": 8443,
  "endpoint_ip": "203.0.113.12",
  "web_host": "192.168.1.10",
  "bind_ip": "192.168.1.10",
  "admin_subnets": ["192.168.1.0/24", "10.8.0.20"],
  "auto_updates": true,
  "channel": "stable"
}
```

These are documentation addresses. Substitute your own reachable endpoint and administrator networks. An explicit config file authorizes unattended application without the terminal confirmation.

## Optional private maps and GeoIP

The installed stack starts without bundled production datasets. Use `bungee-host.py datasets --maps /path/region.mbtiles --geoip /path/City.mmdb` to validate/import local OpenStreetMap raster tiles and a free local GeoIP City database through the same rollback transaction. No provider credentials or runtime lookups are needed. See [formats, free sources, privacy and dataset recovery](GEOGRAPHY.md).

## Network restrictions and local repair

The gateway firewall accepts dashboard TCP 443 inside its namespace only from your administrator prefixes. Docker maps your chosen host HTTPS port to that listener. Caddy independently checks the actual remote connection address before proxying dashboard/API requests. Forwarded-IP headers do not grant access. The private health listener binds only `127.0.0.1:8090`; internal APIs and that listener are not published.

Publicly forwarding the GUI port does not remove these checks. Prefer LAN/VPN access. Rules match the source **seen by the server**: NAT, SSH tunnels and reverse proxies can change it. Docker IPv6-to-IPv4 proxying can obscure addresses. Do not compensate by allowing an entire Docker bridge/proxy network; multiple outside users can share that apparent source. Use a path preserving the intended source, then verify allowed and denied clients. No upstream proxy is automatically trusted.

A mistaken list still leaves local/SSH administration available:

```sh
sudo python3 /opt/bungee/bungee-host.py configure
sudo python3 /opt/bungee/bungee-host.py status
```

`configure` reviews the settings and applies changes through the same maintenance/snapshot/recovery transaction. No dashboard endpoint can widen the list, control Docker or invoke the root updater. Preserve the installation directory and volumes; do not edit generation pointers during an update.

## Update transaction

The mechanism is **Docker Compose image replacement driven by a host systemd timer**. App containers have no Docker socket and cannot upgrade themselves. Stable is the default channel; preview updates require an explicit choice. The timer checks daily with up to an hour of random delay and after boot. Disabling automatic updates stops registry checks. Concurrent local/timer operations share a lock.

1. Pull a small channel bundle. Its container is never started; only JSON is copied out. Validate its schema, fixed repositories, immutable digests, release train, version and publication time. Reject previews on stable, downgrades, replays and incompatible host/data contracts. Automatic updates stay within the installed major/minor release train.
2. Download all three candidate images before downtime. A failed pull leaves the running stack alone. Identical image sets need no restart.
3. Close phone/dashboard admission and require gateway confirmation. Stop the stack and cold-snapshot all five volumes: database/history, WireGuard identity, peer PSKs and Caddy CA/config. Persist checksums and a recovery journal.
4. Start the whole candidate with admission still closed. Require healthy gateway, Rust and Caddy services. Health checks do not prove every feature or replace a security audit/end-to-end phone test.
5. On a failed trial, stop it, verify/restore the coherent snapshot and restart the old stack before reopening. Record failed bundles to prevent an endless retry loop. On success, persist acceptance before reopening.

Maintenance causes brief server unavailability. Phones retain their bounded offline queues and ordinary networking. Updating the server changes no phone enrollment, permissions, OS settings or APK.

Interrupted transactions are recovered on boot and after updater-service failure. Once either a candidate or a recovered old stack has admitted outside traffic, recovery never blindly restores an older snapshot over later telemetry. If verification, restoration or health fails, admission stays closed with the journal and backups preserved for local repair. Disk loss, host compromise and arbitrary software failures cannot be guaranteed recoverable.

The newest three complete local snapshots are retained. Primary history is not expired. Snapshots can retain deliberately erased records until rotated/disposed of. A historical manual restore is a separate data-recovery operation: it can lose newer records or reintroduce erased ones. It is not an unattended rollback after a successful update.

```sh
sudo python3 /opt/bungee/bungee-host.py update --manual
sudo python3 /opt/bungee/bungee-host.py recover
sudo python3 /opt/bungee/bungee-host.py recover --start
sudo journalctl -u bungee-update.service -u bungee-recover.service
sudo systemctl list-timers bungee-update.timer
```

Plain `recover` handles only a pending transaction and respects an intentionally stopped stack. `recover --start` explicitly starts/checks a repaired or unfinished installation and installs recovery/timer units. Keep volumes, snapshots and journals if repair fails. Production code never runs `down --volumes`, prunes volumes or factory-resets anything.

## Publication, trust and privacy

Required server/web, Android, network and updater checks gate tagged image publication. One channel bundle names all three digests. Preview tags publish to preview; stable tags publish to stable. The maintainer refresh workflow reruns a stable tag's checks and fresh builds to pick up floating Debian base-package patches. Pinned Caddy/Cargo/npm/Android dependencies still require a reviewed release; rebuilding cannot fix every vulnerability.

Bootstrap trust is the checkout you inspect. Subsequent updates trust Docker's HTTPS registry authentication, the fixed Bungee GHCR repositories and their authorized publisher. Digests prevent references changing within a transaction. **Client-side publisher-signature/attestation enforcement is not implemented.** CI provenance metadata does not substitute for verifying it. A compromised publisher/registry account is outside this trust boundary. Host-tool changes and incompatible migrations require a reviewed manual update.

Only the host daemon contacts GHCR/download services. They see ordinary download metadata, including server IP and requested artifacts; no phone database, telemetry, PSK, password or CA key is uploaded. App runtime egress stays denied. Compose explicitly clears Docker-injected runtime proxy settings; local health probes also disable proxies. Build/download proxy settings are separate. This is not anonymous updating or zero provider traffic from the entire host. Disable checks/use an independently managed offline process if download metadata is unacceptable.

The project currently has previews; stable exists only after an intentionally published stable release. Missing/unreachable/private artifacts fail without stopping the current stack. The publisher must verify package visibility, or operators authenticate Docker locally; never put registry credentials into app configuration/chat. Hosted publication, full kernel-WireGuard/systemd installation and physical GrapheneOS behavior are not proven by this cloud's tests. See [VALIDATION.md](VALIDATION.md).

## Review boundaries and proxy identity

Read [REVIEW-2026-10.md](REVIEW-2026-10.md) before enabling unattended use. Registry TLS/digest checks do not verify publisher signatures. Local updater snapshots are root-only plaintext tar archives with checksums: put both `/opt/bungee` and Docker volumes on encrypted storage, encrypt exported copies separately, and test key recovery. No application-level archive encryption is implemented.

Bundled Compose enables `BUNGEE_TRUST_LOOPBACK_PROXY=true` only with the Rust admin listener bound to loopback. Caddy overwrites `X-Bungee-Admin-IP` from the actual TCP peer. Rust does not trust `X-Forwarded-For` or that dedicated header from other peers/default standalone deployments. Do not place another proxy ahead of Caddy and expect its forwarded identity to be accepted. Login limits are five attempts/source/minute and 30 aggregate attempts/minute, with at most two Argon2 checks executing concurrently. Device, enrollment and legacy DNS budgets are separate. Existing allowed clients can still share an IP behind NAT.

## Alpha.10 release and enrollment recovery

`release.json` is copied beside the installed helper and supplies its coordinated release version/contract metadata. Keep it with `bungee-host.py` and `network_config.py` when installing/updating local tooling; do not remove the companion manifest. The server/API and APK derive their displayed release version from the same source; CI rejects mismatched release tags.

The server permits only numeric loopback device-API binds or `10.77.0.1:8081`. Do not publish that private HTTP API. Reissue expired/lost never-enrolled invitations from dashboard Settings with the same phone public key; new token/PSK replace the old ones. If peer publication returns an error, repair server storage and retry that same key; no phone reset is required for an unpaired invitation. Paired/revoked signing identities are not rebound. Use one Rust server writer per state/peer volume. See [the latest review](REVIEW-2026-10-SECOND.md) for transaction, backup and physical-validation limits.


## Alpha.11 privacy protocol upgrade

Update the server before the APK, using the same app signer. Old GPS uploads without a generation receive 409 and keep their local queue until upgrade. The first alpha.11 reconciliation deliberately discards the old untagged phone backlog; subsequent home erasure discards an entire unreconciled old generation. Existing home history and pairing are preserved. See [the adversarial follow-up](REVIEW-2026-10-ADVERSARIAL.md) for exact cancellation/deadline and backup/restore boundaries.

The Rust administrator backend is plain HTTP and accepts **only loopback binds**, even with an HTTPS public origin. Remote HTTPS access goes through the source-restricted local Caddy gateway; an HTTPS origin string never supplies TLS on the Rust socket.
