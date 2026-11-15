# Install and operate Bungee

Use a Linux host you administer, with systemd, kernel WireGuard, Docker Compose 2.24+, IPv4/IPv6 iptables/conntrack, Python 3, OpenSSL, `cryptsetup` and its systemd boot service/generator, `e2fsprogs`, `util-linux`, and `age`. On Debian 13+, install the host tools with `sudo apt-get install cryptsetup systemd-cryptsetup e2fsprogs util-linux age openssl python3`. On other distributions, install the package providing `systemd-cryptsetup@.service` and `systemd-cryptsetup-generator` as well as the listed tools. Docker and Compose must already work locally. The installer refuses remote Docker contexts and unencrypted swap. Disable swap or configure encrypted swap first. Keep a provider console or local console available for recovery.

## Home-server quick start

Use a dedicated Linux host or VM with a reachable LAN address. The examples below use Debian 13; adapt package names on other distributions. Keep local/VM console access during installation and the first reboot. The installer creates host mount and systemd configuration, so this is more than importing a Compose stack into a NAS UI.

1. **Prepare the host.** Install Docker Engine and the Compose plugin using [Docker's distribution-specific instructions](https://docs.docker.com/engine/install/). Compose must be 2.24 or newer. On Debian 13 install the remaining host tools:

   ```sh
   sudo apt-get update
   sudo apt-get install git ca-certificates python3 openssl cryptsetup systemd-cryptsetup e2fsprogs util-linux age kmod
   sudo modprobe wireguard
   sudo docker info
   sudo docker compose version
   swapon --show
   df -h /var/lib
   ```

   The host must support kernel WireGuard and container IPv4/IPv6 iptables/conntrack rules. LXC/unprivileged containers often lack the required kernel/network privileges; use a VM or host with those capabilities. Configure encrypted swap or disable it using your distribution's procedure before installation; the installer refuses plaintext swap. There is no published minimum-RAM benchmark. Leave memory and disk headroom for Rust/Android-tool image builds and map extraction; do not size the host only for the running server.

2. **Reserve a LAN IP and plan storage.** Give the server a DHCP reservation or static address, for example `192.168.1.10`. The default encrypted image allocates 32 GiB up front under `/var/lib/bungee`; image/build cache needs additional host space. Maps, retained history, photos and the three rollback snapshots also need capacity. Capacity is not automatically expanded and primary history is not automatically expired.

3. **Choose the two addresses and ports.** For example, choose WireGuard UDP `49271`, LAN HTTPS TCP `8443`, management address `192.168.1.10`, and administrator sources `192.168.1.0/24` (or narrower host addresses). The phone endpoint is your reachable public numeric IP, not the server's LAN IP when the phone is away. In the detailed JSON example, `203.0.113.12` is a documentation placeholder and must be replaced. The dashboard name/IP is separate from the phone endpoint.

4. **Clone and preview.** The plan prompts for configuration, makes no changes and contacts no services:

   ```sh
   sudo git clone https://github.com/argentumseven/bungee.git /usr/local/src/bungee
   cd /usr/local/src/bungee
   bash scripts/install.sh --plan
   sudo bash scripts/install.sh
   ```

   Use the same answers in the live wizard. Choose a password of at least 16 characters. Review the encrypted-storage capacity and optional map selection before accepting. An existing installation must use `rebuild`, not `install`.

5. **Allow the intended network paths.** Apply the router/host rules below. The installer configures its container namespace, not your router, provider firewall or SSH daemon.

6. **Trust HTTPS and sign in.** Verify the printed CA fingerprint at the server console, import only `/opt/bungee/root.crt` into the administrator's trust store, then open the printed URL (for example `https://192.168.1.10:8443`). If you chose a hostname, its DNS or hosts-file entry must resolve to the management address. Use that exact origin; a different hostname/port is not an interchangeable login URL. See [certificate options](HTTPS.md).

7. **Pair and check a phone.** Install the official APK, create an invitation in the dashboard using the phone's public key, and scan it on the phone. Approve only the features you want, then start sharing. Verify last contact and a GPS observation. Turn Wi-Fi off briefly and verify contact over cellular to test the public UDP path; a successful LAN check alone does not prove port forwarding works. Reconnect and confirm saved history remains. Test alarms/photos on a phone you control before depending on them.

8. **Check operation and recovery.** Run `sudo python3 /opt/bungee/bungee-host.py status`, save the printed URL, and back up the storage/backup keys as described below. Test the first reboot while console access is available. A missing encrypted mount prevents Docker from starting, including unrelated Docker workloads on this host; understand that dependency before choosing a shared host.

### Router, host firewall and ports

These are example ports, not required defaults. Pick an unused WireGuard UDP port other than `51820`; the dashboard can use another HTTPS port.

| Path | Example rule | Exposure |
| --- | --- | --- |
| Away-from-home phones | Router WAN **UDP 49271 → 192.168.1.10 UDP 49271**; allow the same UDP port in the host/provider firewall | The one public Bungee entry point. Keep external and internal ports equal in this setup. Use UDP, not TCP. |
| Administrator browser | Permit **TCP 8443** to `192.168.1.10` from the chosen LAN/management source prefixes | LAN/private management only. No WAN forwarding. For access away from home, use a separate management VPN/private route. |
| Internal device API | `10.77.0.1:8081`, inside the phone WireGuard overlay | Never publish or router-forward TCP 8081. Phones cannot reach the dashboard through this overlay. |
| TLS issuance | No port 80 listener or public certificate challenge in the guided setup | No WAN TCP 80/443 rule is needed. Local certificates renew without an external CA. |
| SSH/Docker | Your existing restricted management policy | Bungee does not expose, secure or reconfigure these host services for you. Never expose a Docker API for Bungee. |

For two layers of NAT, forwarding may be required at both routers. Under CGNAT, forwarding on your own router cannot create an ISP-side public listener: obtain a reachable address from your ISP or provide a separate reachable host/network. With IPv6, use a numeric global address reachable by the phone and an explicit firewall ingress rule; IPv4 NAT instructions do not apply. The endpoint format brackets IPv6. Router hairpin NAT can affect a phone testing the public address from home Wi-Fi.

Public dynamic IP changes are not automatically discovered; DNS endpoint names and automatic rendezvous are not implemented. Plan how you will update/re-pair phones if the endpoint changes. HTTPS may use an internal DNS name independently. Avoid a management LAN/VPN range overlapping `10.77.0.0/24`; broad `10.0.0.0/8` administrator rules are refused.

Docker port publication is part of the host network path. Do not assume a front-end firewall such as UFW automatically filters all published Docker ports: check Docker's firewall guidance and verify the actual allowed and denied source paths. Bungee adds source restrictions in both the shared namespace firewall and Rust, but that does not replace the rest of the host firewall.

## New installation

From this checkout run:

```sh
sudo python3 scripts/bungee-host.py install
```

Choose an internal management bind IP and HTTPS port, explicit internal administrator prefixes, a separate reachable numeric phone endpoint/custom WireGuard UDP port, encrypted storage capacity, and update preference. Port 51820 and allow-everyone administrator prefixes are rejected. No reverse proxy or load balancer is required: Rust serves HTTPS directly.

After building the images, the installer asks you to choose and confirm an
administrator password of at least 16 characters. Entry is hidden and supports
both common Backspace codes. Invalid configuration answers repeat only the
affected field. The password is sent to an isolated local hashing container
through stdin; only its salted Argon2id verifier is written to encrypted storage.
Passwords never go in configuration JSON, command arguments, environment
variables, or installation output. For unattended installation, combine
`--config answers.json --password-stdin` with a dedicated secret-manager pipe;
do not put the password in the shell command itself. `--plan` never asks for it.

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
  "storage_size_gib": 32,
  "auto_updates": true,
  "channel": "stable"
}
```

The installer builds two runtime images, checks kernel WireGuard support, creates a **new** allocated LUKS2 image at `/var/lib/bungee/storage.luks`, and mounts it at `/opt/bungee` (or `--root`). It never formats an existing device/image or overwrites an installation. Storage capacity is allocated up front; retain enough room inside it for live data and cold snapshots. Growing storage requires a planned host maintenance operation; the application never automatically deletes primary history to free space.

The random unlock key is `/etc/bungee/storage.key`, root-owned mode 0600. `crypttab` and `fstab` unlock/mount it at boot without a passphrase. The installer verifies systemd’s cryptsetup target, unlock helper and generator before allocating storage. Debian generates the per-volume service from `crypttab` when systemd reloads. Both entries use `nofail`, with a 30-second mapper wait: an unavailable volume leaves Bungee stopped while the host completes boot. A Docker systemd drop-in requires that mount **before Docker starts**, including automatic container restarts. This dependency affects the host Docker daemon: a missing/broken Bungee mount keeps Docker from starting. Restore storage/key from the host console; keep the Docker mount dependency to prevent plaintext fallback directories. Normal source rebuilds repair the installer-owned boot entries without replacing storage or keys.

### Recover a missing boot unlock service

If boot reports `/dev/mapper/bungee` timed out and `systemd-cryptsetup@bungee.service` is not found, but `/etc/bungee/storage.key` and `/var/lib/bungee/storage.luks` exist, log in as root at the host console. Open the existing image and resume boot:

```sh
cryptsetup open --key-file /etc/bungee/storage.key /var/lib/bungee/storage.luks bungee &&
systemctl reset-failed &&
systemctl start opt-bungee.mount &&
systemctl default
```

After normal networking returns, install the missing Debian component and repair the existing boot entries from the checkout (no running Docker daemon or mounted `/opt/bungee` is needed for `repair-boot`):

```sh
apt-get update &&
apt-get install -y systemd-cryptsetup &&
cd /usr/local/src/bungee &&
git pull --ff-only origin main &&
python3 scripts/bungee-host.py repair-boot
```

`repair-boot` checks existing image/key permissions, changes only recognized installer-owned crypttab/fstab entries and the matching Docker drop-in, and reloads systemd. It refuses custom or duplicate entries. It does not unlock, format, mount, replace keys, restart Docker or change application records. Use `--root` with a custom installation path; its mount unit name also differs from `opt-bungee.mount`.

All persistent application state, WireGuard/peer secrets, CA/leaf keys, local configuration and backups live inside this encrypted mount. Runtime scratch files use tmpfs. Containers have read-only roots, no new privileges, disabled core limits, and no Docker socket. Rust also disables Linux process dumps before reading secrets. The gateway alone receives NET_ADMIN, CHOWN and DAC_OVERRIDE; Rust runs as UID 10001 with zero capabilities.

## Trust the dashboard

See [HTTPS and certificate options](HTTPS.md) for local trust, operator-supplied PEM certificates, renewal ownership and browser compatibility.

The host generates a private local CA and 90-day leaf certificate without contacting a certificate provider. The public root is `/opt/bungee/root.crt`. Verify its printed SHA-256 fingerprint through the local console or an authenticated channel, then explicitly trust it in the administrator browser/profile. The CA private key remains host-only; Rust receives a read-only leaf directory. Never export private keys or bypass TLS verification.

Use a current browser supporting TLS 1.3 X25519MLKEM768. Classical-only key exchange and TLS 1.2 fail. Sign in to the exact configured HTTPS origin with the password you chose during installation. There is no generated default or password-retrieval file.

Change it in **Settings → Administrator password**, supplying your current
password and confirming the new one. All browser sessions are signed out.
If forgotten, reset it locally on the host:

```sh
sudo python3 /opt/bungee/bungee-host.py password
```

The reset prompts privately, does not require the old password, and takes effect
without restarting the container. Only a salted Argon2id verifier is stored in
the private SQLite database on encrypted storage. Existing installs migrate their
old password once on startup and remove the live `admin-password` file after the
verifier commits. Your old password continues working until changed. Old encrypted
snapshots can still contain the previous plaintext credential; migration does not
rewrite backups or promise forensic erasure. Rotate any exposed old password.

The daily host timer renews certificates locally even when automatic software updates are disabled. Rust reloads valid certificate replacements every minute. Renewal retains the CA identity; CA expiry/compromise needs a planned replacement and renewed trust on administrator devices.

## Update from GitHub

To upgrade the running containers directly from an updated source checkout:

```sh
cd /usr/local/src/bungee &&
git pull --ff-only origin main &&
sudo python3 scripts/bungee-host.py rebuild &&
sudo python3 /opt/bungee/bungee-host.py status
```

`rebuild` keeps the existing configuration and pairing/history, builds both images
before downtime, takes an encrypted cold snapshot, and uses the normal health
checks and rollback flow before reopening admission. It also refreshes the
installed host helper. Run it from the source checkout, not `/opt/bungee`.

A source update and a published container-channel update are different paths. `update --manual` checks the published stable/preview bundle; it does not build the latest GitHub main branch. Use the command above for the source workflow. The same command is available in web **Settings → Update this server**. After a version change, install the matching APK from **Settings → Phone app updates** or GitHub Releases.

## Operations and reboot

```sh
sudo python3 /opt/bungee/bungee-host.py status
sudo python3 /opt/bungee/bungee-host.py configure
sudo python3 /opt/bungee/bungee-host.py update --manual
sudo python3 /opt/bungee/bungee-host.py recover
```

Normal reboot unlocks storage, starts Docker, restarts the two containers and runs interrupted-update recovery. Missing keys, failed mounts, malformed firewall configuration or failed recovery keep admission closed. `recover --start` explicitly starts an unfinished/stopped installation after diagnosis. Keep the daily timer enabled for certificate maintenance; disable software downloads with `auto_updates: false`, rather than disabling the timer.

HTTPS is published only on the configured **internal management IP** (`bind_ip`), with an explicit administrator source allowlist. The WireGuard UDP endpoint can be public; do not port-forward HTTPS from a WAN router or publish it on the VPS public interface. Wildcard management binds and binds inside `10.77.0.0/24` are rejected. Administrator prefixes that overlap that phone subnet, including a broad `10.0.0.0/8`, are rejected; enter your actual management VLAN/subnet instead. An address class alone does not define trust: use the internal management address and routed source prefixes you control.

Server `wg0` permits only phone C2 at TCP `10.77.0.1:8081`. All other `wg0` INPUT is dropped **before** the ESTABLISHED/RELATED accept rules. It cannot reach the dashboard, any administrator API, SSH or another local service, even by targeting the container's `eth0` address. FORWARD remains DROP.

Rust's administrator TLS socket uses `SO_BINDTODEVICE=eth0` in the shared container namespace, independently of its wildcard IPv4 bind. `BUNGEE_ADMIN_INTERFACE` is required for a non-loopback administrator bind and cannot be `wg0`. Unsupported kernel/security policies fail startup; capabilities are never added to work around this. Rust also rejects phone-overlay sources independently of the allowlist. Both layers enforce the actual management-source prefixes; forwarding headers have no authority.

For a VPS without a directly routed internal network, provision a separate management/private network or a distinct host-to-site management tunnel. It must not use the phone `wg0` overlay or overlapping subnet. Bind HTTPS to that management address and restrict host/provider ingress to its routed source prefixes. Restrict host SSH and Docker management to the same internal management zone; the installer does not rewrite the host's SSH daemon or firewall. Do not publish device port 8081.

## Updates, encrypted backups and recovery keys

The host updater downloads immutable images before closing admission. It then disables old container restarts, stops both services, streams each cold data directory through `tar` into **age encryption**, fsyncs the encrypted archives and completion manifest, and trials the candidate. Plaintext tar files are never written. A failed candidate restores the previous cold snapshot before reopening admission. Every archive is fully authenticated before any current directory is replaced. Accepted transactions never restore earlier snapshots over later data. The newest three complete rollback snapshots are retained.

Encrypted archives are under `/opt/bungee/backups/<generation>/*.tar.age`; the separate root-only backup identity is `/etc/bungee/backup-identity`. Copy complete snapshot directories off-host as ciphertext. Back up the LUKS unlock key, backup identity, and LUKS header separately to authenticated encrypted offline media. Never store these keys beside exported ciphertext or in an unencrypted provider snapshot. Losing the LUKS key loses the live filesystem; losing the age identity loses archive recovery. Key rotation must retain old recovery identities until their archives are retired. Header backups contain key slots and need the same protection as unlock material.

A host-stored key enables unattended boot. It protects a stolen data image/archive without its key; it does **not** protect against root compromise, a provider reading guest memory, or a full-host snapshot that contains the host key. Use a provider/hypervisor you trust, a patched minimal OS, SSH keys, restricted SSH/admin sources and encrypted host/backup media. Avoid hibernation and plaintext crash/memory dumps. Provider disk encryption alone does not hide data from that provider.

## Legacy plaintext-storage installations

The guided host uses storage contract 2. Current contract-2 installations update with the rebuild command above. Older plaintext-volume deployments need migration. The old host helper refuses incompatible releases; there is no silent conversion of its plaintext volumes. Preserve data and follow [the migration procedure](MIGRATION-1.1.4.md). Do not run an old Compose file against new paths, copy live SQLite files, or delete old volumes before encrypted recovery has been verified.

`compose.yaml` and `.env.example` describe the two-container runtime for an **already provisioned** encrypted installation. Use the installer to create keys, certificates, directories and boot ordering; `docker compose up` alone does not provide these host safeguards.

## Offline maps and GeoIP

Fresh guided installs seed a 7.7 MB Natural Earth world overview and bundled DB-IP Lite City data (IPv4/IPv6), then offer a regional street-map selection. The storage prompt defaults to 32 GiB. Street-map acquisition checks the size of US tiles at zoom 15, then zoom 14 if needed; it refuses extracts above 25 GB or available encrypted capacity. The world overview stays usable if a download fails. No map provider is contacted while tracking a phone.

For an existing installation, first update its runtime/helper from the current checkout:

```sh
cd /usr/local/src/bungee
git pull --ff-only origin main
python3 scripts/bungee-host.py rebuild
python3 /opt/bungee/bungee-host.py maps-us
```

`maps-us` adds missing default GeoIP data and downloads/imports the US street map. It preserves custom maps and reports insufficient encrypted space before large downloads. It never resizes or replaces existing storage. To install only the bundled overview and GeoIP, without a street download:

```sh
python3 /opt/bungee/bungee-host.py geodata
```

Custom imports still work:

```sh
python3 /opt/bungee/bungee-host.py datasets --maps /path/map.pmtiles --geoip /path/City.mmdb
```

Local raster PNG/JPEG MBTiles, vector MVT PMTiles v3 and City MMDB files are accepted. Data is validated offline before downtime and mounted read-only. Rollback keeps the previous dataset generation. See [GEOGRAPHY.md](GEOGRAPHY.md) for provenance, bounds and licensing.

DNS functionality was removed in 1.1.17. Existing installations discard its old answers; see [upgrade cleanup](DNS-REMOVAL.md) if a phone used the retired relay.

Official APK downloads in GitHub Releases and manager Settings → Phone app updates are identical. Household hosts verify and cache the APK without re-signing it. Existing household-signed phones keep compatible in-app updates; new installations use the shared official identity. Release maintainers configure the persistent key once using [the signing setup helper](MANAGEMENT.md#maintainer-setup-for-the-shared-release-key).

## Uninstall the server/host

Run from this checkout on the server (use `--root` for a custom installation):

```sh
bash scripts/uninstall.sh --plan
sudo bash scripts/uninstall.sh
# Permanently delete the local data, snapshots, certificates and keys as well:
sudo bash scripts/uninstall.sh --purge
```

The default keeps `/var/lib/bungee/storage.luks` and `/etc/bungee/` for recovery,
but unmounts/closes storage and removes its automatic boot configuration. Keep
the image, storage key and backup identity together in a protected backup. This
is an offline archive, not a one-command reinstall; the installer will refuse to
overwrite it. Export needed records before uninstalling.

Uninstall disables Bungee's timer/recovery service, stops and removes its Compose
containers/network, removes its systemd units, its exact crypttab/fstab entries,
and its Docker storage dependency. It does not restart Docker, prune images,
delete unrelated files, change host SSH/firewall settings, remove phone apps,
erase external backups or remove manually imported CA trust. Remove that trust
from each client separately if desired. `--purge` deletes files, and does not
promise forensic erasure of storage or copies.

Use `--yes` for unattended execution after reviewing `--plan`; interactive purge
requires typing `PURGE`. Preview contacts no services and makes no writes; the
live operation additionally checks the installation and host configuration.
An active updater holds a lock and causes uninstall to refuse; let it finish,
then retry. Cleanup stops on failure and retains keys if storage cannot be
detached. If a failure occurs after detachment, inspect the reported step and
remaining boot configuration locally before rebooting; cleanup is not a rollback.
Older installs can run this checkout's helper even if their installed helper
does not yet include `uninstall`.
