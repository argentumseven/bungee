# Implementation priorities

The [reversibility contract](SAFETY.md) takes precedence over adding MDM features. No deployment is currently being operated by the project owner.

## Current preview

Personal Android finder, encrypted app-contained home tunnel, durable GPS/check-in history, recurring lookup/CSV, bounded encrypted offline queue, optional removable administration for screen locking, sound/contact notifications, consent/app lock, strict no-persistent-policy guards and an independent local recovery entry. Server/Docker hardening and legacy DNS-summary compatibility remain. Alpha.7 adds guided host installation, required source-prefix restrictions and a Compose updater with closed admission, coherent snapshots and failed-trial recovery (INSTALL.md), local OpenStreetMap raster basemaps and separate IP/GeoIP history (GEOGRAPHY.md).

Device-owner enrollment/operation, managed system DNS/always-on, package suspension, uninstall prevention, forced credential complexity, blocked recovery settings and reboot have been disabled. No wipe, credential reset, kiosk, bootloader or firmware action exists.

## Before household deployment

1. Prove personal installation/removal, ordinary admin deactivation and independent offline recovery on physical GrapheneOS. Test app lock, bad app state/keys, process death, restart, denied permissions, full storage and server loss; verify normal phone functions and Android Settings remain accessible.
2. Test the actual Docker gateway, direct and other-VPN transport, roaming/MTU/IPv6 and reconnect. Preserve the default app-contained route; do not restore a persistent network policy as a workaround.
3. Validate stable APK signing and in-place update/recovery. Debug signer changes may require personal-app uninstall/re-pair; document the app-data consequence accurately.
4. Add passkeys/MFA and household roles, stronger administrator recovery, immutable dependencies/images, independent security review, publisher-signature enforcement, full-host recovery and load/fault testing. Current classical certificate/device/APK signatures are not fully post-quantum authenticated.
5. Improve idempotent enrollment response recovery, bounded retry/backoff and encrypted direct/relay options for CGNAT without introducing service-provider access to payloads or a persistent phone restriction.

## Suitable small additions

Read-only app-version/security-patch/compliance reporting, clearer failed-command/permission state, local diagnostics with explicit export, accessibility/contrast improvements, translations and additional map coverage formats are candidates. The current local raster OpenStreetMap/City MMDB support labels IP estimates separately and never replaces GPS; future formats must retain those boundaries. They must preserve the ability to stop/uninstall Bungee without a server or Bungee encryption key.

New OS-level controls must remain unavailable if their failure can leave a persistent restriction, close a recovery path, destroy phone data or require reset to remove management. No destructive fallback is acceptable. Do not add wipe/reset-on-failed-unlocks, forced installation restrictions, disabled ADB/USB, hidden launcher, kiosk, credential changes or owner provisioning as an incremental convenience feature.
