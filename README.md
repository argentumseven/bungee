# Bungee

**A private way home for your household’s phones.** A self-hosted, open-source device finder for modern Android, with GrapheneOS as the primary physical-device test target.

This is a working **early foundation**, not an audited anti-theft or MDM product. The Rust API and web dashboard run and pass integration/browser tests. The Android APK builds. Physical-device behavior, real WireGuard connectivity, and device-owner provisioning still need testing. Do not rely on it as your only way to recover a phone.

![Bungee dashboard](docs/screenshots/dashboard.png)

## What is here

- **Rust server:** separate administrator/device listeners; SQLite; Argon2id administrator authentication; HttpOnly, SameSite cookies; exact-origin CSRF checks; bounded requests and authentication rate limits.
- **React dashboard:** household phones, battery, last-known coordinates, enrollment QR codes, capability-aware commands, receipts, revocation, and an audit trail. Responsive, with no analytics, external fonts, external map tiles, or cloud account.
- **Native Kotlin/Compose app:** phone-generated WireGuard identity; Android Keystore signing; encrypted local secrets; QR pairing; explicit consent; foreground sharing; per-phone capability switches; optional biometric/device-credential app lock.
- **Narrow WireGuard route:** only Bungee’s `10.77.0.1/32` destination, and only the Bungee Android package. No default route, DNS change, or general internet forwarding.
- **Commands:** locate, ring for up to 30 seconds, stop sound, post/clear a recovery notification, and request a lock when the user has enabled Android device administration. Delivery and execution are distinct. Commands expire after five minutes.
- **Deployment:** Docker Compose with a separate WireGuard gateway and Caddy for HTTPS. Only the gateway has network-administration capability. The Rust container runs as a non-root user with no Linux capabilities and a read-only root filesystem.

There are no live phones, sample coordinates, or hard-coded credentials in the normal dashboard. Test fixtures live only in temporary test instances.

## Start development

Prerequisites: Node 24, Rust 1.90.0, a JDK (not a JRE), Android SDK 36 / Build Tools 35.0.0, and Chromium for browser checks. The optional cloud setup script installs verified tool downloads in `/workspace/.cache/bungee`.

```sh
bash scripts/setup-cloud.sh
source scripts/dev-env.sh
bash scripts/dev-server.sh
```

The server uses administrator port 8080 and a separate local device-test port 8081. Its generated administrator password is in `.state/admin-password` (mode 0600). Read it locally; never commit it or paste it into an issue. Local development uses HTTP bound to loopback. Non-loopback dashboards require an HTTPS public origin.

```sh
source scripts/dev-env.sh
cargo build --locked --manifest-path server/Cargo.toml
npm test
npm run test:browser
bash scripts/android.sh :app:assembleDebug :app:lintDebug
```

The installable **development-only** APK is `android/app/build/outputs/apk/debug/app-debug.apk`. It uses a debug signing key. Release signing keys, distribution, update continuity, and a security review are required before shipping. `assembleRelease` produces an unsigned release artifact until you configure signing outside source control.

For web hot reload, run the Rust server with `BUNGEE_PUBLIC_ORIGIN=http://127.0.0.1:5173` and start `npm run dev --prefix web`. Use that exact origin for the browser session; the server intentionally rejects mutations from another origin.

## Deploy on your own server

Use a Linux host with Docker Compose and kernel WireGuard support. Docker Desktop and restricted cloud sandboxes are not the target. The gateway never forwards general internet traffic.

1. Copy `.env.example` to `.env`. Set `BUNGEE_DOMAIN` to your own DNS name and `BUNGEE_WG_ENDPOINT` to your externally reachable `host:51820`.
2. Point DNS at the host. Permit TCP 80/443 for Caddy and forward **UDP 51820** to the gateway. A home connection behind CGNAT needs an independently reachable endpoint; this project does not configure a relay.
3. Run `docker compose up --build -d` and check `docker compose ps` / `docker compose logs`.
4. Read the generated administrator credential **locally** with `docker compose exec server cat /state/admin-password`, then sign in over HTTPS. Protect terminal output. The server never logs the password.
5. Install the APK on a test phone, copy its public key into **Add a device**, and scan the invitation. Approve the VPN and choose location/notification permissions. Start sharing on the phone.

Gateway peers refresh within about three seconds. Invitations expire in ten minutes. If pairing succeeds on the server but the phone loses the enrollment response, revoke that pending device, unpair locally, and generate a fresh invitation. Do not reuse invitations or keys from a revoked phone.

Only 80/443 and WireGuard UDP are published. The administrator and device APIs are not published separately. The private device API uses HTTP **inside the authenticated WireGuard channel**; exposing port 8081 directly would break the transport assumption. See [deployment details](docs/DEPLOYMENT.md).

## Platform boundaries

- Android has **one VPN per profile**. A split tunnel still occupies that slot. Do not enable Android’s “block connections without VPN” option: that would block the normal traffic Bungee is designed to leave outside the tunnel.
- A sharing session is started visibly by the phone’s user. It uses Android location APIs without Google Play services, a foreground notification, and 15-second command polling. It uploads battery/location about once per minute and asks for a new location when the cached fix is over five minutes old. GPS fixes, battery restrictions, connectivity, and OS scheduling affect delivery. Sharing does not automatically resume after reboot or a process termination in this release.
- Recovery messages are ordinary lock-screen notifications. They respect notification permissions and lock-screen privacy settings; they never replace or cover the unlock interface.
- Optional device administration grants **force-lock only**. A device-owner receiver exists for an MDM foundation; full Android Enterprise provisioning and management are not implemented.
- Failed-unlock photos, remote wipe, arbitrary remote shell, launcher hiding, powered-off finding, offline crowdsourced finding, and firmware/activation locks are **not implemented**. Device-owner mode can have additional foreground-service exemptions, so the camera feature needs a separate real-device feasibility study rather than a blanket claim that GrapheneOS cannot support it.

See [capability research](docs/PLATFORM.md), [security design](docs/SECURITY.md), and the [implementation roadmap](docs/ROADMAP.md).

## Privacy and trust

The server keeps the latest telemetry record, not a journey history, and expires it after 24 hours without a check-in. Recovery command content is removed after 24 hours. Revocation clears active telemetry and pending commands, invalidates device authentication, and removes the WireGuard peer. The audit log contains a bounded 10,000 events and excludes coordinates and enrollment tokens. SQLite deletion is logical deletion; use encrypted host disks and encrypted, expiring backups for protection against forensic recovery.

The administrator and home server are trusted and can read device locations. This is not end-to-end encryption against the administrator. No claim of audit, attestation, penetration testing, or guaranteed hardware-backed keys is made. Android Keystore uses the device’s available security implementation; hardware-backed key verification and server-verified attestation are future hardening work.

AGPL-3.0-only. See [LICENSE](LICENSE).
