# Bungee

**[Download Android APK](https://github.com/argentumseven/bungee/releases/latest/download/bungee.apk)** · [SHA-256 checksum](https://github.com/argentumseven/bungee/releases/latest/download/bungee.apk.sha256) · [Release notes and older APKs](https://github.com/argentumseven/bungee/releases)

Open `bungee.apk` on your phone to install it. Every checked main-branch Android build is published in Releases with its source commit; these downloads do not expire or require an Actions login.

<img src="web/public/bungee-mark.png" width="96" alt="Bungee home and location icon">

Bungee is a self-hosted device finder for Android 12+ and GrapheneOS. Pair household phones with your server to save location history, send recovery commands and view optional theft photos.

The Kotlin app connects through an app-contained WireGuard tunnel to a Rust server and web dashboard. Only Bungee traffic uses that tunnel; Android's VPN slot remains available. Phone records stay on your server until you erase them or revoke the device.

**Version 1.1.17.** Physical GrapheneOS testing and an independent security audit are pending. See the [validation record](docs/VALIDATION.md) for completed checks and [security design](docs/SECURITY.md) for the trust model.

![Bungee dashboard in dark mode](docs/screenshots/dashboard.png)

<a id="feature-checklist"></a>

## Features

| Area | Features |
| --- | --- |
| Dashboard | Multiple named phones, enrollment state, last contact, battery/charging, dated last-known GPS and accuracy, manual refresh, mobile layout, sign-out |
| GPS history | Saved observations and check-in logs; inclusive time ranges; pagination; point selection and coordinate trail; CSV downloads with cancellation and server resource limits |
| Recurring lookups | All records, newest per 5 minutes/hour/custom 1–1,440 minutes, or nearest to a daily time in an IANA timezone; configurable ±0–120 minute tolerance; matching CSV; originals preserved. Interval ranges: 366 days/10,000 buckets; daily ranges: 366 days |
| Maps | Regional OpenStreetMap vector PMTiles and raster MBTiles, local street labels, one map for GPS/current/history views, installed-map picker and capacity checks; no public tile fallback |
| IP history | Authenticated WireGuard endpoint observations, IPv4/IPv6, offline City MMDB estimates with radius/database age, separate time/recurrence lookup and CSV; IP estimates stay separate from GPS |
| Dataset imports | Validated local map/GeoIP imports, read-only files, rollback on failed trials, explicit removal; no runtime provider downloads or accounts |
| Offline GPS | Independent sampling, individually AES-GCM encrypted SQLite records, up to 10,080 unique unsent fixes, bounded uploads, deduplication, transactional legacy-queue migration and capacity-loss counts |
| Poor connectivity | Network-aware exponential backoff/jitter, adaptive 1–100-point catch-up, command priority, encrypted receipt retries, late receipt reconciliation and separate contact/telemetry ages. [DDIL details](docs/DDIL.md) |
| Last-known location | Retained through outages, missing fixes and server restarts; older backfills cannot replace a newer point |
| Recovery commands | Fresh GPS, alarm/flash, messages, normal Android screen lock and Stop all actions; cancellation of current actions and queued offers; five-minute normal expiry, 24-hour stop expiry and phone-reported outcomes |
| Alarm | Bundled rising/falling siren, at most 30 seconds, phone alarm volume and interruption settings, local stop controls, two-second browser preview |
| Messages | Up to 240 characters in Android recovery notifications; lock-screen and heads-up illustrations in the dashboard; normal credential entry remains accessible |
| Lost mode | Saved state survives outages, one lock attempt per revision when permitted, contact notification and more frequent check-ins |
| Theft photos | One-time local approval, visible Camera2 foreground service, high-quality front-camera JPEGs targeting 2048 pixels / quality 90, up to 1 MiB each; further captures after three additional eligible failed entries, 30-second minimum spacing and 20 attempts/hour; labelled tests and EXIF removal |
| Photo recovery | RAM-only eight-photo queue, same-boot process recovery preserves failure counts/rate limits; optional boot/update restoration after first Android unlock through a brief startup screen and separately granted special access |
| Photo gallery | Signed uploads, authenticated paginated gallery, capture/receipt times, local-test labels and separate photo erasure; old erased generations cannot upload again |
| Phone consent | QR or pasted invitation, separate GPS/command consent, commands off by default, visible sharing notification, optional restart after first unlock, background-location grant for automatic GPS recovery, authenticated unpairing |
| Local recovery | Separate offline launcher independent of pairing keys, Compose and native transport; authenticated stop, saved stop across reboot/update, cleanup results, Android Settings links and explicit manual restart |
| App privacy | Biometric/device-credential app lock, screen capture/OS backup disabled, Keystore signing key, AES-GCM local secret/queue storage; no Play services, analytics, crash-upload or push provider |
| Appearance | System/Light/Dark themes on web and Android, saved local choices, slate/charcoal/teal palettes and pink home/location icon |
| VPN coexistence | Userspace WireGuard/TCP carries the fixed home API without OS routes, root or VpnService. Other VPNs can route or filter the outer UDP socket |
| Device status | Desired/applied policy revision and errors, Android/security-patch version, screen-lock state, eligible failed-credential counts, lost mode and dated queue/camera reports |
| Recovery safeguards | Server/client reject persistent policy fields and remote reboot; device/profile ownership blocks operation; owner provisioning disabled; no app suspension, uninstall blocks, forced credentials, kiosk or recovery-settings restrictions |
| Pairing | Phone-generated identity, one-use ten-minute invitation bound to its public key, safe unpaired-invitation reissue, P-256 proof/signatures, replay protection and unique random 256-bit WireGuard PSK |
| Network setup | Operator-chosen numeric endpoint and UDP port; 51820 rejected; only `10.77.0.1/32` routed inside Bungee; no default internet route |
| Administrator access | Argon2id password verification, bounded login work, HttpOnly/SameSite sessions, exact-origin mutation checks, separate admin/device listeners and rate budgets, source-prefix restrictions, security audit events and same-origin CSP |
| Retention and erasure | GPS/IP/check-in/photo records retained until erased/revoked; separate location/history/photo erasure; transactional GPS/photo generations reject erased backlog; revocation deletes device data and tunnel access |
| Containers | Non-root Rust service, zero capabilities and read-only root; isolated WireGuard gateway; host-only local CA; direct Rust HTTPS; TLS 1.3 X25519MLKEM768; new runtime application egress denied |
| Installation | Prompted WireGuard/web ports, endpoint/bind address and mandatory administrator hosts/prefixes; bare hosts become /32 or /128; no-write plan, exact HTTPS URL and CA fingerprint; existing installations refused |
| Server updates | Host systemd timer with Compose image replacement, immutable two-image bundles, staged downloads, admission closed during trials, coherent encrypted cold snapshots, failed-trial recovery and three retained snapshots |
| Builds | ARM64/x86_64 APK, coordinated `release.json`, CI checks and checksums, operator-owned stable signing option, source and synthetic test fixtures |

Bungee does not support device-owner/work-profile management, forced system DNS, app suspension, hidden launchers, lock-screen overlays, airplane-mode cycling, radio schedules, power-off/reboot/wipe, credential reset, arbitrary scripts or software deployment. Powered-off finding, a crowdsourced offline network, relay/NAT traversal, household roles/MFA and hardware attestation are also unavailable. Guided installs include the world overview and DB-IP Lite City data and offer a regional street-map checklist. Settings → Maps & storage offers the same regional downloads, planned sizes, installed maps and safe free capacity.

## Install the server

Use a Linux host with Python 3, Docker Engine, Compose 2.24+, systemd and kernel WireGuard support. Start with the guided installer:

```sh
bash scripts/install.sh --plan   # validate answers without writes or network calls
sudo bash scripts/install.sh    # configure and start the stack
```

Server administration uses only your internal management network. Publish HTTPS on that host address and allow only its source prefixes. Phone `wg0` carries C2 only; it cannot reach the dashboard, administrator API or host management. A VPS needs a separate private management route.

The wizard asks for ports and mandatory administrator source hosts/prefixes. It configures source restrictions in both the gateway firewall and Rust HTTPS. Verify the printed local-CA fingerprint and trust the public root certificate on administrator devices before signing in. Keep persistent data and backups on encrypted storage.

For phones away from home, the selected WireGuard UDP endpoint must be reachable. Public IPv4 normally requires forwarding that UDP port on your router; CGNAT needs another reachable path. The dashboard can stay on your LAN/VPN. WireGuard provides encryption; it does not create inbound reachability. No relay is included.

See [installation and updates](docs/INSTALL.md) for the wizard, network rules and recovery commands, or [manual Compose deployment](docs/DEPLOYMENT.md). To remove the host installation, preview with `bash scripts/uninstall.sh --plan`, then run `sudo bash scripts/uninstall.sh`; add `--purge` to delete local encrypted data and keys. See [uninstall details](docs/INSTALL.md#uninstall-the-serverhost). [Map and GeoIP setup](docs/GEOGRAPHY.md) covers local datasets, imports and licenses.

## Install and pair a phone

Download **manager Settings → Phone app updates → Download this server’s APK** for a persistent signing identity and future in-app updates. The host prepares the APK for its exact server version automatically. The public **[bungee.apk](https://github.com/argentumseven/bungee/releases/latest/download/bungee.apk)** and [checksums/source](https://github.com/argentumseven/bungee/releases/latest) remain available as standalone builds. Main-branch releases publish after the APK and signing pipeline checks succeed.

**For in-app updates, install the manager’s APK before pairing the phone.** The standalone CI APK has a disposable signer, with Android debugging disabled. Older GitHub APKs need one reinstall to switch certificates; **Reconnect · keep history** preserves their saved server records. After that, use Bungee’s App updates screen for in-place updates. See [signing and migration](docs/MANAGEMENT.md#stable-signing-and-updates). Install Bungee as an ordinary personal app; **do not enroll it as device owner**.

1. Open Bungee on the phone and copy its WireGuard public key.
   After an uninstall/reinstall, clearing app data, or generating new phone keys,
   copy the key again and make a fresh invitation. An invitation for the previous
   key will say it belongs to another phone. Purging a binding does not restore
   the phone's old private key.
2. In the trusted dashboard, choose **Add a device**, enter a name and paste that key.
3. Scan the invitation with Bungee, or paste its enrollment text. Review sharing consent and choose **Agree & pair**. Invitations expire after ten minutes and contain a long-lived secret; keep them out of photos, messages and synchronized clipboards.
4. Grant precise GPS permission and start sharing. Recovery commands need separate approval on the phone. Screen locking also needs removable device administration.
5. If pairing was interrupted, use **Retry saved pairing**. Reissue an expired, never-enrolled invitation from Settings using the same public key. Reissue rotates the token and PSK; an already paired signing identity cannot be rebound.

Revoking a device erases its saved records and removes tunnel access. Keep a missing phone enrolled if you want it to report again.

## Recovery controls

Overview shows all household phones and their last reported battery/network state. Click a phone or use the Devices submenu for its recovery controls and cancelable tasks. **Cancel** removes a queued task; **Stop retries** prevents redelivery of an offered task, which may already be running. A late receipt remains visible.

**Tracking** separates the current weighted estimate, GPS history, IP observations, check-ins and household photos. Updated phones average fresh GPS samples; optional lost-mode haste samples roughly every 10 seconds with a shorter window. **Best guess** requests a longer GPS burst. GPS history filters passive, homing, haste and best-guess records before pagination/recurrence. Raw saved records stay available; estimates do not claim survey accuracy. A reported system VPN warns about GeoIP exit-location reliability, not satellite GPS quality. **Tunnels** shows signed API round trips, jitter and probe success since the phone process started, with last-report timestamps.

**Sound alarm** plays for up to 30 seconds, temporarily maximizes Android’s alarm volume and restores the prior level. **Alarm + flash** and **Flash only** use the rear flashlight when the phone grants camera access. Do Not Disturb, routing and interruption settings can affect audibility. Stop it from the dashboard, the phone notification after unlocking, or local recovery. System/hardware controls can still silence or stop the app. **Preview alarm sound** plays only in the browser.

Recovery messages use Android notifications. Android controls heads-up and lock-screen visibility; Bungee leaves credential entry accessible. The dashboard preview is an illustration:

![Recovery notification illustration](docs/screenshots/notification-preview.png)

Enable **Automatic theft photos** on the phone before it is lost. Start sharing, approve commands, enable removable administration and grant camera/notification access. Choose **Enable theft photos** and authenticate once. While **Ready**, three new eligible failed PIN/password entries trigger one capture attempt. Biometric failures may not produce callbacks.

For restoration after reboot or an app update, separately enable **Automatic recovery after reboot** and grant Android's **Display over other apps** access. After the first Android unlock, a brief startup screen restores the approved service and closes automatically. Pairing keys remain credential-encrypted until that first unlock. Unsent photos are RAM-only and disappear if the process exits. Force-stop, revoked permissions and OS restrictions can require manual attention. See [camera setup, limits and device checks](docs/RECOVERY_CONTROLS.md).

![Recovery gallery with a synthetic test image](docs/screenshots/recovery-photos.png)

**Stop all Bungee actions** stops an already playing siren and blinking flashlight, restores alarm volume, cancels remote work and older queued commands, clears the recovery notification, and turns off lost mode/haste. The phone must be reachable; a separate stop check runs while actions are active. Ordinary sharing and pairing stay intact. **Lock device** uses Android's standard screen lock: it does not change the credential or wipe anything. A stop can cancel a lock before it executes but cannot unlock Android afterward; unlock normally on the phone.

Bungee does not configure, relay or log phone DNS. DNS functionality was removed in 1.1.17. See [upgrade cleanup](docs/DNS-REMOVAL.md) if you enabled it in an earlier version.

**Pairing & recovery** is a visible button inside the normal phone app, including its lock screen. There is one launcher icon; the recovery panel works offline even when pairing keys cannot be opened. Stop preserves pairing and server history; reset pairing separately clears Bungee's local connection and queued records. Phone keys are kept unless you explicitly select fresh keys for a damaged identity. Android management repair is a separate confirmed action and never wipes a phone or removes a profile. Resume sharing in the main app; clearing a stop restores no camera/restart consent.

To reuse a phone public key after a failed or deleted pairing, open **Settings → Inactive pairings** in the manager and purge the revoked record or expired, unused invitation. Revoke a previously paired device first. Create a fresh invitation afterward; old tokens and secrets never become valid again. Offline paired devices are protected from purge.

See the [removal audit](docs/REMOVAL_AUDIT.md) for ownership, partial-pairing, update and failed-cleanup scenarios.

## History and data handling

**Tracking** searches GPS, IP observations and check-ins by time range, interval or daily recurrence. CSV exports use the same filters and stream to the browser's Downloads panel, where they can be cancelled. Exports are plaintext sensitive records; store them on encrypted media. Lines between GPS samples show their order, not a measured continuous route.

![Daily history lookup](docs/screenshots/history-daily.png)

![Separate IP history with synthetic map tiles and test GeoIP data](docs/screenshots/history-ip.png)

The latest check-in, last authenticated contact and last GPS observation have separate timestamps. A fresh battery report does not make an old location current. Server history has no automatic expiry or size-based eviction; monitor disk capacity and back up coherently.

**Settings → Erase saved history** removes GPS, IP/GeoIP, photos, check-ins and the last-known location while preserving pairing. Separate photo and GPS-only erasure are also available. Erasure rotates generations so old queued or in-flight data cannot restore erased GPS/photos. On reconciliation, the phone discards the entire old-generation queue, including observations made before it learned of the erase. New observations can arrive while sharing remains enabled. Deletion does not scrub filesystem blocks or existing backups.

Turning off GPS cancels pending work and clears unsent GPS. Stopping sharing preserves the encrypted GPS backlog, disarms the camera and attempts unsent-photo cleanup. Neither removes records already saved on the server. Bytes already sent cannot be recalled.

The administrator can read device locations and uploaded photos. Runtime app/server components use no analytics, public map/GeoIP service, FCM, external fonts or provider account. Dependency downloads and optional host updates expose download metadata to their registries. Android/GNSS assistance, browser sync, DNS and any proxy you add have their own configuration and trust requirements. WireGuard PSKs and hybrid TLS protect confidentiality; certificate, device and APK signatures still use classical cryptography. See [security and cryptographic limits](docs/SECURITY.md).

## Build and check

Run the development setup once:

```sh
bash scripts/setup-cloud.sh
```

Then build and test:

```sh
source scripts/dev-env.sh
npm --prefix web run build
cargo build --locked --manifest-path server/Cargo.toml
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
npm run test:browser
npm run test:tls # Docker + Node 24/OpenSSL 3.5
bash scripts/build-transport.sh
(cd native/transport && go test ./... -count=1)
bash scripts/android.sh :app:assembleDebug :app:lintDebug :app:testDebugUnitTest
```

For normal installations, download **manager Settings → Phone app updates → Download this server’s APK**. The host prepares it automatically; future updates are available inside the paired phone app with a persistent server signer. See [the one-time transition from old GitHub APKs](docs/MANAGEMENT.md#stable-signing-and-updates).

The local development APK is `android/app/build/outputs/apk/debug/app-debug.apk`. `assembleRelease` is unsigned until you configure a signer outside source control. `scripts/build-owner-apk.sh` uses an operator-owned signing key; its historical name does not enable Android ownership.

The server's administrator HTTP listener binds loopback on port 8080; device tests use 8081. Passwords are stored only as salted Argon2id verifiers. Before a first development launch, build the server and initialize a password privately:

```sh
cargo build --locked --manifest-path server/Cargo.toml
python3 -c 'import getpass, subprocess; subprocess.run(["server/target/debug/bungee-server", "--set-admin-password"], input=getpass.getpass("Administrator password (at least 16 characters): ").encode(), check=True)'
```

For web hot reload, start Rust with `BUNGEE_PUBLIC_ORIGIN=http://127.0.0.1:5173` and run `npm run dev --prefix web`; use that exact browser origin. In production, choose the password during installation and change it in **Settings → Administrator password**, or reset it with `python3 /opt/bungee/bungee-host.py password` as root. See [installation](docs/INSTALL.md) for migrating and rebuilding existing containers.

See the [platform matrix](docs/PLATFORM.md), [management guide](docs/MANAGEMENT.md), [recovery requirements](docs/SAFETY.md), [remaining work](docs/ROADMAP.md) and [writing guide](docs/WRITING.md).

AGPL-3.0-only. See [LICENSE](LICENSE).

Server deployment now uses direct Rust HTTPS, LUKS2 persistent storage with host-key unattended unlock, and age-encrypted cold backups. General phone forwarding and new runtime application egress stay disabled. See [installation](docs/INSTALL.md), [VPS routing](docs/DEPLOYMENT.md), and [1.1.4 migration](docs/MIGRATION-1.1.4.md).

## Regional maps

Choose maps in the server installer or **Settings → Maps & storage**. The catalogue has 248 choices: eight US regions (including Alaska/Hawaii) and country regions grouped by continent. Checkboxes show rough sizes and a combined estimate; **Calculate download sizes** obtains a current extraction plan before **Download selected maps**. Up to 24 regions / 25 GB of street maps can be installed. Free-space checks count existing data/rollback copies and leave system, staging and swap-growth headroom. Downloads are verified and become available in all tracking views without restarting the server.

The same picker is available locally:

```sh
python3 /opt/bungee/bungee-host.py maps
```

For a scripted selection, use `maps --regions us-pacific,us-mountain`; add `--plan` to fetch sizes without installing archives. `maps-us` remains an alias for all eight US regions. Full postal-address reverse geocoding is not bundled; nearby mapped street names are explicitly approximate.

![Regional map picker and storage capacity](docs/screenshots/maps-storage.png)

**Pairing & history** keeps disconnect, reconnect, erasure and inactive pairing cleanup together, with each action’s effects visible before confirmation. Reboot/update reminder alerts are disabled; Android-required running-service notifications remain silent.
