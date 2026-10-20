# Remaining work

The [feature list](../README.md#features) describes current behavior. New controls must preserve the [local recovery requirements](SAFETY.md).

## Testing and security

| Work | Completion criteria |
| --- | --- |
| Physical GrapheneOS testing | Record OS/build and results for GPS, notifications, failed-credential capture, boot/update recovery, Doze, network transitions, another VPN, permission revocation, local stop and removal. Follow [the device procedure](RECOVERY_CONTROLS.md#physical-device-checks) |
| Independent security audit | Review the app, enrollment protocol, native transport, server and installer/updater; resolve findings with regression coverage |
| Publisher-authenticated updates | Verify image publisher identity on the host, with key rotation, compromise recovery and offline operation defined |
| Host boot/fault acceptance | Exercise LUKS2 host-key unlock, mount-before-Docker ordering, encrypted swap, cold age archive recovery and power loss on supported Linux hosts |
| Administrator access | Design passkeys/MFA, individual users, device-scoped roles and administrator recovery/rotation |
| Endpoint changes | Authenticate numeric home-endpoint updates without losing identity/history or introducing a provider lookup |
| Capacity and fault testing | Measure large histories, exports, low storage, power loss and snapshot recovery on supported hardware |
| Accessibility | Test screen readers, large text, touch targets and keyboard use on both clients; add translations |

## Possible additions

Low-battery and missed-check-in alerts can use existing reports without an external notification provider. Other candidates are geofence events from saved GPS, local readiness checks for notification/alarm settings, and time-limited faster location sampling. Each needs clear timestamps, offline handling and local consent.

Additional map formats must keep location requests on the home server. Any control affecting OS settings needs a documented recovery path that still works if Bungee or the server fails. Wipe, credential reset, hidden launchers, kiosk mode, owner provisioning and persistent restrictions remain excluded.

## Review records

The October reviews and their corrections are retained in [the first review](REVIEW-2026-10.md), [second review](REVIEW-2026-10-SECOND.md) and [adversarial review](REVIEW-2026-10-ADVERSARIAL.md). Current test results are in [VALIDATION.md](VALIDATION.md).
