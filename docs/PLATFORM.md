# Platform research and feature feasibility

Research uses public platform source where web documentation was unavailable. Source behavior is evidence for an implementation plan, not proof that a particular GrapheneOS build has been tested.

## Find My as a reference

Useful product concepts are a device list, last-known location with freshness, sound, a lost-device contact message, locking/erasure, and a clear distinction between an online command and a pending command. Apple also has a crowdsourced offline-finding network and platform/firmware integration. A self-hosted Android application does not inherit either capability. Bungee’s first release covers the online household workflow and intentionally exposes receipt/freshness information.

The [Apple Find My device guide](https://support.apple.com/guide/iphone/locate-a-device-iph09b087eda/ios) is a primary reference to review. Its content could not be fetched through this cloud instance’s current network policy. It is not represented as a retrieved or newly verified source.

## What the Android sources establish

| Feature | First implementation | Evidence / next constraint |
| --- | --- | --- |
| Narrow transport | Personal app-contained WG/gVisor TCP, fixed home API, no OS VPN; optional managed VpnService /32 + home DNS, no default route | AOSP VpnService documents one VPN and routes; WireGuard GoBackend installs peer AllowedIPs as routes and explicitly allows IPv4/IPv6 families when there is no default route |
| GrapheneOS networking | Android VPN and LocationManager, no Play services dependency | GrapheneOS publishes standard Android VPN support; physical phone test remains required |
| Online location | Visible user-started foreground service; GPS_PROVIDER only | User permission, provider availability, doze/battery scheduling; powered-off/before-first-unlock finding not implemented |
| Remote ringing | Bounded foreground alarm tone with local stop action | Audio settings and OEM/OS behavior still apply; DND bypass is not requested |
| Recovery message | Notification with public lock-screen visibility; authenticated in-app dismissal | Notification permissions and lock-screen privacy can suppress it; no overlay or full-screen intent |
| Remote lock | Explicit Android device administration, force-lock policy only | DevicePolicyManager.lockNow; app rechecks administration before execution |
| MDM | Explicit local consent; finite owner policies, system DNS, selected-app suspension, protection/strong-lock controls, provisioning activities and signed state/errors | Full turnkey GrapheneOS provisioning, work profiles, remote software deployment and enterprise lifecycle remain future work; see MANAGEMENT.md |
| Three failed-unlock photos | Deferred, no misleading switch | DeviceAdminReceiver has password-failure callbacks under the watch-login policy, with profile/owner constraints. These are credential events, not a promise to observe all biometric failures. Camera foreground and while-in-use restrictions apply. AOSP ActiveServices explicitly has a **device-owner exception** for while-in-use FGS permissions. Validate on target GrapheneOS, with opt-in, visible disclosure, bounded encrypted retention, and privacy-indicator behavior before implementing |
| Lock-screen overlay | Deferred | Do not use accessibility privileges or obscure PIN/password entry. An ordinary notification is the first safe supported UX |
| App lock | Android BiometricPrompt with strong biometric or device credential; FLAG_SECURE | UI privacy, not a second independent OS sandbox; verify lifecycle behavior on a phone |
| Optional hidden launcher | Deferred | Requires a visible enrollment/sharing indicator and a reliable authenticated way to restore access, including after force-stop/reboot and notification revocation. Hiding must never become covert enrollment or tracking |
| Reboot / power-off | Opt-in owner reboot with local approval, administrator reauthentication and accepted/completion-unconfirmed receipts | Public DevicePolicyManager.reboot exists; ordinary stock device-owner apps have no equivalent shutdown API. First-unlock recovery unavailable after reboot; physical validation required |

Do not enable VPN lockdown (“block connections without VPN”) for this split-tunnel design. It would change normal traffic behavior. Managed DNS / Android always-on cannot share a profile VPN slot with a second VpnService app. Default app-contained WireGuard leaves that slot free, subject to the other VPN filtering the outer UDP socket. See [MANAGEMENT.md](MANAGEMENT.md) for implementation and limits.

See [management research and setup](MANAGEMENT.md) for Private DNS precedence, failed-credential signals, provisioning/ownership lifecycle and additional primary sources.

## Sources retrieved

- [AOSP VpnService.java](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/net/VpnService.java): one VPN at a time, package allowlists, routes, and address families.
- [WireGuard GoBackend.java](https://github.com/WireGuard/wireguard-android/blob/master/tunnel/src/main/java/com/wireguard/android/backend/GoBackend.java): route installation, excluded/included applications, non-default-route family behavior, VPN socket protection, and tunnel lifecycle.
- [AOSP DeviceAdminReceiver.java](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/app/admin/DeviceAdminReceiver.java): onPasswordFailed and watch-login requirements.
- [AOSP DevicePolicyManager.java](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/app/admin/DevicePolicyManager.java): lockNow and owner provisioning contracts.
- [AOSP ActiveServices.java](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/services/core/java/com/android/server/am/ActiveServices.java): while-in-use FGS permission restrictions and device-owner exceptions.
- [GrapheneOS FAQ source](https://github.com/GrapheneOS/grapheneos.org/blob/main/static/faq.html#L1444) and [public FAQ](https://grapheneos.org/faq#vpn-support): VPN support and OS networking behavior. The GitHub source was retrieved; the public site was blocked.
- [WireGuard tunnel Maven metadata](https://repo.maven.apache.org/maven2/com/wireguard/android/tunnel/maven-metadata.xml): published Android library version used by this build.

Additional official documentation, queued in the cloud network draft but not retrievable in this running instance: [Android VPN guide](https://developer.android.com/develop/connectivity/vpn), [foreground service types](https://developer.android.com/about/versions/14/changes/fgs-types-required), and [DevicePolicyManager reference](https://developer.android.com/reference/android/app/admin/DevicePolicyManager).
