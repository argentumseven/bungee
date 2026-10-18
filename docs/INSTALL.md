# Install and operate Bungee

Use a Linux host you administer, with systemd, kernel WireGuard, Docker Compose 2.24+, IPv4/IPv6 iptables/conntrack, Python 3, OpenSSL, `cryptsetup`, `e2fsprogs`, `util-linux`, and `age`. On Debian/Ubuntu, install the host tools with `sudo apt-get install cryptsetup e2fsprogs util-linux age openssl python3`. Docker and Compose must already work locally. The installer refuses remote Docker contexts and unencrypted swap. Disable swap or configure encrypted swap first. Keep a provider console or local console available for recovery.

## New installation

From this checkout run:

```sh
sudo python3 scripts/bungee-host.py install
```

Choose an internal management bind IP and HTTPS port, explicit internal administrator prefixes, a separate reachable numeric phone endpoint/custom WireGuard UDP port, optional DNS resolver, encrypted storage capacity, and update preference. Port 51820 and allow-everyone administrator prefixes are rejected. No reverse proxy or load balancer is required: Rust serves HTTPS directly.

For unattended setup, pass `--config answers.json`. Preview without root, Docker, file writes or network access:

```sh
python3 scripts/bungee-host.py install --plan --config answers.json
```

Example answers (replace documentation addresses):

```json
{
  "wg_port": 49271,
  "web_port": 8443,
  "endpoint_ip": "203.0.113.12",
  "web_host": "192.168.1.10",
  "bind_ip": "192.168.1.10",
  "admin_subnets": ["192.168.1.0/24"],
  "dns_upstream_ip": "",
  "dns_upstream_port": 53,
  "storage_size_gib": 8,
  "auto_updates": true,
  "channel": "stable"
}
```

The installer builds two runtime images, checks kernel WireGuard support, creates a **new** allocated LUKS2 image at `/var/lib/bungee/storage.luks`, and mounts it at `/opt/bungee` (or `--root`). It never formats an existing device/image or overwrites an installation. Storage capacity is allocated up front; retain enough room inside it for live data and cold snapshots. Growing storage requires a planned host maintenance operation; the application never automatically deletes primary history to free space.

The random unlock key is `/etc/bungee/storage.key`, root-owned mode 0600. `crypttab` and `fstab` unlock/mount it at boot without a passphrase. A Docker systemd drop-in requires that mount **before Docker starts**, including automatic container restarts. This dependency affects the host Docker daemon: a missing/broken Bungee mount keeps Docker from starting. Restore storage/key from the host console; do not remove the dependency and let Bungee create plaintext fallback directories.

All persistent application state, WireGuard/peer secrets, CA/leaf keys, local configuration and backups live inside this encrypted mount. Runtime scratch files use tmpfs. Containers have read-only roots, no new privileges, disabled core limits, and no Docker socket. Rust also disables Linux process dumps before reading secrets. The gateway alone receives NET_ADMIN, CHOWN and DAC_OVERRIDE; Rust runs as UID 10001 with zero capabilities.

## Trust the dashboard

The host generates a private local CA and 90-day leaf certificate without contacting a certificate provider. The public root is `/opt/bungee/root.crt`. Verify its printed SHA-256 fingerprint through the local console or an authenticated channel, then explicitly trust it in the administrator browser/profile. The CA private key remains host-only; Rust receives a read-only leaf directory. Never export private keys or bypass TLS verification.

Use a current browser supporting TLS 1.3 X25519MLKEM768. Classical-only key exchange and TLS 1.2 fail. Read the administrator password locally using the Compose command printed by installation; its file is `/state/admin-password` inside Rust. Sign in to the exact configured HTTPS origin.

The daily host timer renews certificates locally even when automatic software updates are disabled. Rust reloads valid certificate replacements every minute. Renewal retains the CA identity; CA expiry/compromise needs a planned replacement and renewed trust on administrator devices.

## Operations and reboot

```sh
sudo python3 /opt/bungee/bungee-host.py status
sudo python3 /opt/bungee/bungee-host.py configure
sudo python3 /opt/bungee/bungee-host.py update --manual
sudo python3 /opt/bungee/bungee-host.py recover
```

Normal reboot unlocks storage, starts Docker, restarts the two containers and runs interrupted-update recovery. Missing keys, failed mounts, malformed firewall configuration or failed recovery keep admission closed. `recover --start` explicitly starts an unfinished/stopped installation after diagnosis. Keep the daily timer enabled for certificate maintenance; disable software downloads with `auto_updates: false`, rather than disabling the timer.

HTTPS is published only on the configured **internal management IP** (`bind_ip`), with an explicit administrator source allowlist. The WireGuard UDP endpoint can be public; do not port-forward HTTPS from a WAN router or publish it on the VPS public interface. Wildcard management binds and binds inside `10.77.0.0/24` are rejected. Administrator prefixes that overlap that phone subnet, including a broad `10.0.0.0/8`, are rejected; enter your actual management VLAN/subnet instead. An address class alone does not define trust: use the internal management address and routed source prefixes you control.

Server `wg0` permits only phone C2 at TCP `10.77.0.1:8081` and optional legacy DNS at UDP/TCP `10.77.0.1:5353` after the port-53 redirect. All other `wg0` INPUT is dropped **before** conntrack's established/related rules. It cannot reach the dashboard, any administrator API, SSH or another local service, even by targeting the container's `eth0` address. FORWARD remains DROP.

Rust's administrator TLS socket uses `SO_BINDTODEVICE=eth0` in the shared container namespace, independently of its wildcard IPv4 bind. `BUNGEE_ADMIN_INTERFACE` is required for a non-loopback administrator bind and cannot be `wg0`. Unsupported kernel/security policies fail startup; capabilities are never added to work around this. Rust also rejects phone-overlay sources independently of the allowlist. Both layers enforce the actual management-source prefixes; forwarding headers have no authority.

For a VPS without a directly routed internal network, provision a separate management/private network or a distinct host-to-site management tunnel. It must not use the phone `wg0` overlay or overlapping subnet. Bind HTTPS to that management address and restrict host/provider ingress to its routed source prefixes. Restrict host SSH and Docker management to the same internal management zone; the installer does not rewrite the host's SSH daemon or firewall. Do not publish device port 8081 or DNS port 5353.

## Updates, encrypted backups and recovery keys

The host updater downloads immutable images before closing admission. It then disables old container restarts, stops both services, streams each cold data directory through `tar` into **age encryption**, fsyncs the encrypted archives and completion manifest, and trials the candidate. Plaintext tar files are never written. A failed candidate restores the previous cold snapshot before reopening admission. Every archive is fully authenticated before any current directory is replaced. Accepted transactions never restore earlier snapshots over later data. The newest three complete rollback snapshots are retained.

Encrypted archives are under `/opt/bungee/backups/<generation>/*.tar.age`; the separate root-only backup identity is `/etc/bungee/backup-identity`. Copy complete snapshot directories off-host as ciphertext. Back up the LUKS unlock key, backup identity, and LUKS header separately to authenticated encrypted offline media. Never store these keys beside exported ciphertext or in an unencrypted provider snapshot. Losing the LUKS key loses the live filesystem; losing the age identity loses archive recovery. Key rotation must retain old recovery identities until their archives are retired. Header backups contain key slots and need the same protection as unlock material.

A host-stored key enables unattended boot. It protects a stolen data image/archive without its key; it does **not** protect against root compromise, a provider reading guest memory, or a full-host snapshot that contains the host key. Use a provider/hypervisor you trust, a patched minimal OS, SSH keys, restricted SSH/admin sources and encrypted host/backup media. Avoid hibernation and plaintext crash/memory dumps. Provider disk encryption alone does not hide data from that provider.

## Upgrade from 1.1.4

This changes the host/storage contract to version 2. The old host helper refuses incompatible releases; there is no silent conversion of its plaintext volumes. Preserve data and follow [the migration procedure](MIGRATION-1.1.4.md). Do not run an old Compose file against new paths, copy live SQLite files, or delete old volumes before encrypted recovery has been verified.

`compose.yaml` and `.env.example` describe the two-container runtime for an **already provisioned** encrypted installation. Use the installer to create keys, certificates, directories and boot ordering; `docker compose up` alone does not provide these host safeguards.

## Offline maps and GeoIP

```sh
sudo python3 /opt/bungee/bungee-host.py datasets --maps /path/map.mbtiles --geoip /path/City.mmdb
```

Only local raster MBTiles and City MMDB files are accepted. A new immutable dataset directory is validated offline before downtime and mounted read-only. Rollback keeps the previous dataset generation. See [GEOGRAPHY.md](GEOGRAPHY.md) for provenance, bounds and licensing.
