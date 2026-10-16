# Platform capability and safety boundaries

The reference product concepts remain device list, dated last-known location/history, sound, a lost contact message and honest command receipts. Apple's crowdsourced offline network, powered-off finding and activation lock are platform services; Bungee does not implement them.

Alpha.6 adopts a stricter requirement than a conventional MDM: the phone must remain removable/recoverable through ordinary Android controls if Bungee fails. See [SAFETY.md](SAFETY.md).

| Capability | Current implementation | Boundary |
| --- | --- | --- |
| Private home transport | Official WireGuard + gVisor TCP inside the app, fixed home API and mandatory peer PSK | No Android VPN service/OS routes/system DNS; another VPN can filter the outer socket |
| GPS/history | Visible sharing service, GPS_PROVIDER only, timestamped history and bounded encrypted backlog | Permissions, GNSS, Android background rules and battery controls still apply; no Play services dependency |
| Sound/contact | Bounded alarm tone, local stop, ordinary recovery notification | Notification visibility/privacy/audio rules still apply; no overlay covers credential entry |
| Optional screen lock | Ordinary removable force-lock/watch-login device administration | Existing OS credential only; user can deactivate administration in Settings. No PIN setting/reset/complexity policy |
| Lost mode | Durable contact intent and one lock per revision when permitted | Local stop/deactivation takes precedence; no owner lock-screen policy is installed |
| App lock | Android strong biometric/device credential, FLAG_SECURE | Recovery has a separate entry and no independent app PIN or pairing-key dependency |
| Local recovery | Separate Android-view launcher, persisted local stop, independent cleanup and Settings links | Does not guarantee removal of old device ownership or recovery from OS/hardware failure |
| Device-owner MDM | Disabled | OS-managed ownership can require a reset to remove. Provisioning is disabled/cancelled; new app refuses owner operation |
| Persistent DNS/always-on/suspension/settings restrictions | Disabled in server, app and UI | Saved legacy DNS/read-only reports remain for compatibility; no new enforcement |
| Reboot/power-off/wipe/credential reset/kiosk | Unavailable | No execution branch for reboot; old queued reboots rejected. No firmware/root/bootloader modifications |
| Failed-unlock photos | Absent | Watch-login does not count every biometric event. Camera restrictions/owner exceptions do not satisfy the current safe, tested recovery contract |
| Hidden launcher / lock-screen overlays | Absent | Recovery entry must remain accessible; normal unlock controls remain usable |

An app cannot honestly promise zero failures or reverse the OS's device-owner lifecycle in every failure state. A fallback timer is insufficient when a persistent restriction survives an app that no longer runs. This is why this release withholds owner authority instead of calling the existing controls universally reversible.

Primary sources consulted:

- [AOSP DevicePolicyManager](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/app/admin/DevicePolicyManager.java): ordinary force-lock, ownership and policy lifecycle.
- [AOSP DeviceAdminReceiver](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/app/admin/DeviceAdminReceiver.java): credential events/deactivation.
- [AOSP VpnService](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/net/VpnService.java): system VPN routing and authority.
- [Official WireGuard netstack](https://github.com/WireGuard/wireguard-go/blob/2631ce99a06f27120d581611cf125d68bc6aa565/tun/netstack/tun.go): pinned app-contained transport.
- [GrapheneOS features](https://grapheneos.org/features): native USB protection and automatic reboot, which Bungee does not reconfigure.

Source APIs establish feasibility, not proof of physical GrapheneOS behavior. Required field checks are listed in SAFETY.md and actual results in VALIDATION.md.
