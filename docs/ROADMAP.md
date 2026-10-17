# Implementation priorities

The [reversibility contract](SAFETY.md) takes precedence over adding MDM features.

## Implemented features

Personal Android finder, encrypted app-contained home tunnel, durable GPS/check-in history, recurring lookup/CSV, bounded encrypted offline queue, optional removable administration for screen locking, sound/contact notifications, consent/app lock, strict no-persistent-policy guards and an independent local recovery entry. Server/Docker hardening and legacy DNS-summary compatibility remain. Alpha.7 adds guided host installation, required source-prefix restrictions and a Compose updater with closed admission, coherent snapshots and failed-trial recovery (INSTALL.md), local OpenStreetMap raster basemaps and separate IP/GeoIP history (GEOGRAPHY.md).

Alpha.8 adds network-aware DDIL retries, independent GPS sampling, adaptive catch-up, encrypted receipt retries and explicit uncertainty/queue status (DDIL.md). Field validation remains outstanding.

Device-owner enrollment/operation, managed system DNS/always-on, package suspension, uninstall prevention, forced credential complexity, blocked recovery settings and reboot have been disabled. No wipe, credential reset, kiosk, bootloader or firmware action exists.

## Verification and hardening work

1. Prove personal installation/removal, ordinary admin deactivation and independent offline recovery on physical GrapheneOS. Test app lock, bad app state/keys, process death, restart, denied permissions, full storage and server loss; verify normal phone functions and Android Settings remain accessible.
2. Test the actual Docker gateway, direct and other-VPN transport, roaming/MTU/IPv6 and reconnect. Preserve the default app-contained route; do not restore a persistent network policy as a workaround.
3. Validate stable APK signing and in-place update/recovery. Debug signer changes may require personal-app uninstall/re-pair; document the app-data consequence accurately.
4. Add passkeys/MFA and household roles, stronger administrator recovery, immutable dependencies/images, independent security review, publisher-signature enforcement, full-host recovery and load/fault testing. Current classical certificate/device/APK signatures are not fully post-quantum authenticated.
5. Field-test interrupted enrollment recovery and DDIL retry/backoff, and investigate encrypted direct/relay options for CGNAT without introducing service-provider access to payloads or a persistent phone restriction.

## Suitable small additions

Read-only app-version/security-patch/compliance reporting, clearer failed-command/permission state, local diagnostics with explicit export, accessibility/contrast improvements, translations and additional map coverage formats are candidates. The current local raster OpenStreetMap/City MMDB support labels IP estimates separately and never replaces GPS; future formats must retain those boundaries. They must preserve the ability to stop/uninstall Bungee without a server or Bungee encryption key.

New OS-level controls must remain unavailable if their failure can leave a persistent restriction, close a recovery path, destroy phone data or require reset to remove management. No destructive fallback is acceptable. Do not add wipe/reset-on-failed-unlocks, forced installation restrictions, disabled ADB/USB, hidden launcher, kiosk, credential changes or owner provisioning as an incremental convenience feature.

## Alpha.9 review follow-up

The independent review confirmed defects in GPS restart permissions, full-blob offline storage, pre-authentication limiter allocation, receipt settlement, offered-command terminology, authentication cooldown and proxy login accounting. Source corrections and regression checks are described in [REVIEW-2026-10.md](REVIEW-2026-10.md). Physical GrapheneOS acceptance, publisher-signature enforcement, encrypted snapshot archives, endpoint-change recovery, scalable CSV streaming and accessibility validation remain open. Indefinite server history remains the explicitly requested policy.

## Alpha.10 second-review follow-up

Checked, explicit command consent; recoverable invitation lifecycle/peer publication; strict device API bind; bounded server-streamed CSV; and coordinated release metadata are implemented with regression evidence in [REVIEW-2026-10-SECOND.md](REVIEW-2026-10-SECOND.md). Streaming CSV is no longer an unbounded browser-array feature. Physical GrapheneOS, update publisher authentication, encrypted snapshot archives, administrator roles/MFA, endpoint changes and accessibility/endurance remain open.


## Alpha.11 adversarial follow-up

Implemented: transactional GPS erasure generations, cancellation of stale capture/upload reservations, continuous remote-locate consent checks, exact-point acknowledgment and commit-admission expiry, loopback-only admin HTTP, bounded separate JSON readers, interval span/bucket limits and accurate durable-stop labels. [Detailed evidence and limits](REVIEW-2026-10-ADVERSARIAL.md).

Remaining work includes publisher-authenticated updates, authenticated encrypted archive recovery and physical GrapheneOS/storage/network testing. Local cancellation cannot recall bytes already delivered to the server.
