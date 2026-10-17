# Android capabilities

Bungee installs as a removable personal app. Optional ordinary device administration provides screen locking and eligible credential callbacks. Android device ownership is disabled because removing it can require a reset. See [recovery requirements](SAFETY.md).

| Capability | Implementation | Limits |
| --- | --- | --- |
| Home connection | WireGuard and gVisor TCP inside the app, fixed home API, mandatory peer PSK | No OS VPN routes or DNS changes; another VPN can filter the outer socket |
| GPS and history | Visible service, GPS_PROVIDER, dated observations and bounded encrypted backlog | Requires precise location; automatic restart also requires background location. GNSS, battery and background rules affect collection |
| Alarm | Bundled siren for up to 30 seconds, with local stop | Android alarm volume, routing and interruption settings determine audibility |
| Recovery message | Android notification and dashboard preview | Android determines visibility/layout; credential entry remains accessible |
| Screen lock | Removable force-lock/watch-login administration | Uses the existing phone credential; administration can be deactivated in Settings |
| Lost mode | Saved contact message and one lock attempt per revision | Subject to local consent and permissions; local stop takes priority |
| Theft photos | Locally approved camera foreground service, one attempt after three new eligible failed PIN/password entries | Android can refuse camera access; biometric callbacks vary. Physical GrapheneOS capture testing is pending |
| Boot camera recovery | Separate opt-in and Display over other apps grant; visible startup activity after first unlock | One launch attempt per boot/app version; force-stop can require manual launch. See [setup](RECOVERY_CONTROLS.md) |
| App lock | Existing Android strong biometric/device credential, FLAG_SECURE | Sharing continues in the background; recovery has a separate entry |
| Local recovery | Android-view launcher, saved stop, independent cleanup and Settings links | Works without pairing keys; cannot remove legacy Android ownership reliably or repair OS/hardware faults |
| Device/profile-owner MDM | Disabled | Provisioning cancels; both owner roles and failed role queries block normal operation |
| Persistent DNS, always-on VPN, app suspension and settings restrictions | Disabled on server/client | Earlier DNS summaries remain readable/erasable; new enforcement is rejected |
| Airplane-mode cycle | Unavailable through official app/MDM grants | Direct two-way changes need protected system networking authority. See [API analysis](AIRPLANE_MODE.md) |
| Reboot, power-off, wipe, credential reset and kiosk | Unavailable | Old queued reboots are rejected; no firmware/root/bootloader changes |
| Hidden launcher and lock-screen overlay | Unavailable | Recovery and normal Android unlock controls remain accessible |

Apple's crowdsourced offline network, powered-off finding and activation lock depend on platform services that Bungee does not implement.

## Sources

- [AOSP DevicePolicyManager](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/app/admin/DevicePolicyManager.java): force-lock, ownership and policy lifecycle.
- [AOSP DeviceAdminReceiver](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/app/admin/DeviceAdminReceiver.java): credential events and deactivation.
- [AOSP VpnService](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/net/VpnService.java): system VPN routing.
- [WireGuard netstack](https://github.com/WireGuard/wireguard-go/blob/2631ce99a06f27120d581611cf125d68bc6aa565/tun/netstack/tun.go): pinned app-contained transport.
- [GrapheneOS features](https://grapheneos.org/features): native USB protection and automatic reboot, configured independently of Bungee.

[VALIDATION.md](VALIDATION.md) records completed checks. API/source inspection and automated tests do not establish physical-device behavior.
