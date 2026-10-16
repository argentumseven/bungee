# Implementation roadmap

## First release foundation (implemented)

Rust server, separate API surfaces, native Android client, WireGuard configuration with a fixed /32 and package allowlist, QR enrollment with proof of key possession, signed/replay-protected telemetry, capability-based command queue/receipts, revocation, a responsive dashboard, app lock, device-admin lock support, and Docker Compose. Durable time-sliced GPS/check-in history, CSV export, an encrypted bounded offline GPS queue, mandatory custom UDP ports, per-peer 256-bit PSKs, local-CA hybrid TLS, and runtime outbound-deny firewall policy are also implemented.

## Next: demonstrate it on a test GrapheneOS phone

1. Establish a real handshake against the Docker stack. Verify using packet capture/routes that only Bungee’s home traffic enters the tunnel and browsing/DNS/IPv6 remain on ordinary routes. Test replacement by another VPN and explain Android’s single-VPN constraint in onboarding.
2. Exercise first enrollment, timeout/retry recovery, clock skew, revoke/re-pair, approximate/precise location, GPS without Play services, and network handoffs. Add idempotent enrollment response recovery and bounded backoff/jitter for long server outages.
3. Test command authorization, permission changes, duplicate delivery, process interruption, notification privacy, alarm settings, screen locking, and biometric app-lock lifecycle on GrapheneOS.
4. Define always-on behavior with explicit user consent: doze/battery use, process death, reboot, first unlock, boot-time restrictions, and visible status. Do not assume a foreground service or timer is immortal. The server now retains the last-known checkpoint indefinitely, but it cannot receive a position a disconnected or powered-off phone never sent.
5. Design relay-assisted, outbound-only phone/home connections for CGNAT and easy deployment, preserving end-to-end phone-to-home encryption. Keep direct mode available. Evaluate integrated mesh transport against Android's one-VPN-per-profile constraint; add automatic endpoint/DNS refresh and network-handoff tests. An external VPN app is not a supported workaround for the current hard-coded private device API route.
6. Field-test the bounded encrypted GPS queue across outages, doze, full storage and reconnect. Add owner-controlled scheduled retention as an optional policy while keeping indefinite server history the default. Test date-range exports under concurrent backfills, history volume growth and restore. Keep one-shot command deadlines separate from durable lost-mode intent; a siren request should not unexpectedly execute days later.
7. Complete authenticated post-quantum identity/provisioning and update signatures using reviewed standard implementations. Current PSK tunnel protection and hybrid TLS key exchange do not make classical certificate/request signatures quantum-resistant. Add a verified local/offline enrollment method and an authenticated endpoint-update flow for changing home IPs without provider DNS.

## Security release gate

Passkeys/MFA, separate household administrator/member roles, reauthentication for sensitive actions, credential recovery/rotation UI, immutable image/dependency provenance, signed APK releases and updates, database migration policy, tests for expired invitations/commands and concurrent revocation, key-level hardware checks/attestation, a threat-model review and independent security audit. Validate restored snapshots and backups separately. Container functionality does not establish that production TLS/DNS or a phone works.

## Managed-device capabilities

Build modern Android Enterprise provisioning activities and an explicit device-owner enrollment flow. Keep personal and fully managed modes visibly distinct. Add policy schemas, scoped RBAC, audit and two-step authorization before considering destructive operations such as wipe or reset. Research failed-credential callbacks plus a device-owner camera foreground service on the target GrapheneOS release; make any resulting image capture opt-in, disclosed, encrypted, short-lived, and bounded. Test user/profile scope and do not count biometric failures as credential failures without evidence.

## Recovery and polish

Self-hosted offline map tiles, multi-device coordinate plotting, accessibility/contrast review, translations, secure notifications with authenticated dismissal semantics, owner contact cards, location freshness modes, battery-aware intervals, multiple-household roles, optional launcher icon hiding with visible status and reliable recovery after reboot/force-stop, and first-run deployment diagnostics. There is no plan to pretend an ordinary Android app can supply Apple’s offline crowd network, activation lock, or firmware-level powered-off finding.
