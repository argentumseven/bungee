# Recovery, managed DNS and device ownership

Bungee is a small, self-hosted recovery tool with optional finite device-owner policies. There is no remote shell, arbitrary policy executor, surveillance timeline, app-attributed browsing log or automatic wipe. A server policy is desired state; the dashboard separately shows the phone's signed report and errors. Reports are not hardware attestation.

## Choose a connection mode

| Mode | Traffic | Android VPN slot | Prerequisites |
| --- | --- | --- | --- |
| Personal / default | Only Bungee's fixed home API over app-contained WireGuard + gVisor TCP | Free for another VPN | Pairing, Android Network permission, visible service; GPS separately consented |
| Android always-on | Bungee package and home `/32` through WireGuard VpnService | Occupied | Device owner and local management consent |
| Managed system DNS | Profile apps may reach home `/32`; Android system DNS uses home; all other routes remain direct | Occupied | Device owner, local consent, configured private upstream, Bungee always-on, no lockdown |

The default mode creates no TUN interface or Android VPN configuration. Another VPN sees its outer UDP socket as ordinary app traffic and can carry or block it. Bungee does not bypass a VPN lockdown/firewall or guarantee every VPN combination. Network handoff/roaming and actual coexistence on GrapheneOS still need field tests.

Redirecting other apps' system DNS needs Android's routing privileges. Ordinary app-contained WireGuard cannot intercept those apps' DNS. Arbitrary second VpnService apps cannot stack in one profile. An integrated VPN/OS router could combine functions, but that is not implemented. Rooting GrapheneOS is not required or recommended for this design.

## Stable signing and updates

**Do not use ephemeral CI debug keys for a persistent device-owner deployment.** Android requires the same signing identity for in-place updates. Uninstalling a device owner is not an ordinary app operation and can require decommissioning/reset. Preserve the owner key before provisioning. Losing it can strand updates.

Create your own private keystore on a trusted development machine, outside the checkout, and back it up offline. Example (interactive passwords, never a command-line password):

```sh
keytool -genkeypair -keystore /secure/offline/bungee-owner.jks \
  -alias bungee -keyalg EC -groupname secp256r1 -validity 3650
export BUNGEE_OWNER_KEYSTORE=/secure/offline/bungee-owner.jks
# Prepare the pinned SDK/NDK/Go tools, then:
bash scripts/build-transport.sh
bash scripts/build-owner-apk.sh
```

The helper prompts silently for the store password, signs an optimized release, lints it, verifies its public signing certificate and prints SHA-256. Set `BUNGEE_OWNER_KEY_ALIAS` or securely inject `BUNGEE_OWNER_KEY_PASSWORD` only when needed. Keep the same key and increase versionCode for every update. Install with `adb install -r android/app/build/outputs/apk/release/app-release.apk`. Compare the public signer fingerprint to the previous trusted APK before updating. Do not upload private keys/passwords into issues, this repository or chat. This is operator signing support, not a hosted production update service; APK signatures remain classical.

## Enroll a dedicated test phone

Ownership controls the Android device, not just Bungee. Back up personal data first and use a fresh eligible dedicated test phone. GrapheneOS setup-wizard provisioning support varies; the protected Android 12+ provisioning/compliance activities are present, but a turnkey GrapheneOS QR bootstrap has not been verified.

For a supported Android test setup with ADB, install the **stable owner-signed** APK, then use Android's documented device-owner test flow before adding accounts/users or completing conflicting provisioning:

```sh
adb install android/app/build/outputs/apk/release/app-release.apk
adb shell dpm set-device-owner org.bungee.app/.BungeeAdminReceiver
```

Android decides eligibility and may reject an already provisioned phone. Do not circumvent those checks or silently reset a personal phone. After enrollment, disable USB debugging unless actively testing. Device ownership is separate from pairing: open Bungee, pair normally with the home server, authenticate locally and explicitly approve **managed controls**. The server cannot grant its own management consent. Provisioning does not silently pair or enable policies.

Personal phones can use recovery notifications, sound, GPS and optional legacy device-admin screen locking without device ownership. Failed-credential reports depend on watch-login/admin eligibility; they are not biometric attempt counters. No automatic photos are taken.

## Configure home DNS

In `.env`, set a private numeric upstream reachable **from the shared Docker namespace**:

```dotenv
BUNGEE_DNS_UPSTREAM_IP=192.168.1.53
BUNGEE_DNS_UPSTREAM_PORT=53
```

Restart/recreate the Compose stack after configuration changes. There is no public resolver default or fallback. Private IPv4, ULA IPv6 and loopback are accepted; Bungee's tunnel subnet and Docker's `127.0.0.11` resolver are rejected. Loopback refers to the containers' shared namespace, not the Docker host. Configure a separate home resolver such as your own Unbound server; its retention, recursion/forwarding and upstream privacy are your responsibility. DNS inherently sends questions to that configured resolver. Bungee does not secretly select a provider. The LAN hop to the private resolver uses UDP/TCP; the phone-to-home hop is encrypted WireGuard. Use an isolated trusted home network if LAN confidentiality is required.

**Device care → optional device-owner controls → Use home DNS** also requests Android always-on without lockdown. Bungee sets Private DNS to opportunistic so a previously configured third-party DoT hostname cannot override the home resolver, and prevents user DNS changes while managed DNS is active. Applying Private DNS can fail with unaffiliated users; failures are displayed. No public DoT provider is configured by Bungee. Review Android Private DNS settings after releasing policies; the previous setting is not automatically restored.

The gateway accepts DNS from `wg0` only and redirects UDP/TCP port 53 to the unprivileged server listener at 5353. Port 53 is never published on the host. The resolver accepts only enrolled, non-revoked PSK peers whose signed report matches the managed DNS policy revision, owner consent and always-on state. It rechecks authorization after waiting for the upstream to prevent a revoked peer receiving a late answer. The firewall permits new egress only to the chosen private upstream IP/port. No general internet forwarding is enabled.

Coverage includes the managed profile's **Android system resolver**. Apps with their own DoH/DoT or hard-coded DNS, other profiles and periods without Bungee VPN remain limitations. This split route is not a guarantee that every DNS packet is forced home. Suspending selected user apps stops those apps completely, including their alternative resolvers; it cannot selectively disable only their DoH. System/core apps and Bungee cannot be suspended. Package visibility and Android exemptions may prevent suspension, and the phone reports errors.

## Read DNS at a glance

Choose a phone and 24-hour, 7-day or 30-day range. Bungee stores only five-minute rollups and returns the top 100 groups:

- Registrable-site grouping uses the bundled public-suffix list, including private suffixes. Full random subdomains are discarded before storage.
- A/AAAA/HTTPS, retries and repeated requests for one group in a 10-second window count as one grouped activity. Raw query totals remain available; activity windows do not mean visits or people.
- Known GrapheneOS/Android DNS probes share a system-check group. Reverse lookups/local names are grouped separately. There are no provider classification calls or external threat feeds.
- Counts include answer/NXDOMAIN/error totals and query types, plus first/last seen. Cached answers on the phone are invisible. No answer addresses, payloads or app attribution are retained.
- Summaries survive outages/restart and have no automatic expiry. Separate **Erase DNS summaries** removes them; fresh/in-flight activity may appear while DNS stays enabled. Revocation deletes summaries and policies. Five-minute boundary rollups can include activity just outside the selected window.

## Recovery and policy lifecycle

Lost mode is persistent intent, unlike the five-minute siren/command queue. The phone attempts a screen lock once per saved revision, shows a contact notification and, when device owner, owner lock-screen text. A failed lock is retried and reported. Normal unlock entry remains usable. Clearing a local notification does not turn off the server policy. GPS is still sampled about once a minute; lost mode increases check-in frequency, subject to OS scheduling.

Optional policies are finite: always-on, restart after first unlock, uninstall protection, high password complexity, selected-app suspension and recovery settings restrictions. Settings restrictions do not prevent hardware recovery/reset, power-off, another profile's traffic, OS compromise or every way to disable connectivity. No remote PIN changes, wipe, hidden package installs or scripts exist.

**Secure reboot** requires device ownership, local management consent, a separate authenticated local reboot opt-in, a secure screen lock, and administrator password re-entry for each command. It invokes public `DevicePolicyManager.reboot`, not shutdown. Receipt status is **accepted; completion unconfirmed** before invoking Android, and can change to failed if Android rejects it (for example during a call). The command is persisted before execution and never automatically repeated. After restart, credential-encrypted pairing state is unavailable until first unlock; location, commands and managed DNS cannot resume before then. Reboot limits access to encrypted user data without destroying it, but is not equivalent to wiping or guaranteed protection against all attacks. A true power-off API is unavailable to an ordinary device-owner app on stock GrapheneOS; no fake shutdown switch or privileged exploit is included.

To stop management, authenticate locally and **release Bungee's policies**. It restores apps Bungee suspended, removes its finite restrictions/always-on and withdraws management consent. Pairing/history remain. Unpair releases policies before deleting keys; failures are surfaced instead of silently abandoning restrictions. Review Android network/security settings afterward.

**Policy release does not remove Android device ownership.** Full decommissioning depends on Android provisioning/removal rules; a factory reset may be required. Export needed server records, release Bungee policies while still paired, follow the OS's ownership removal/reset process, then revoke the device on Bungee. Do not uninstall/reset an enrolled phone merely to apply an APK signed by a different key.

## Primary platform sources

- [AOSP DevicePolicyManager](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/app/admin/DevicePolicyManager.java): reboot, owner lock-screen text, Private DNS, always-on, packages suspension, password complexity and provisioning contracts.
- [AOSP VpnService](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/net/VpnService.java): one service per profile, routes and package scope.
- [Official WireGuard userspace netstack](https://github.com/WireGuard/wireguard-go/blob/2631ce99a06f27120d581611cf125d68bc6aa565/tun/netstack/tun.go): app-contained IP/TCP transport used here; module and checksums pinned in native/transport.
- [WireGuard Android GoBackend](https://github.com/WireGuard/wireguard-android/blob/master/tunnel/src/main/java/com/wireguard/android/backend/GoBackend.java): managed VPN routes, DNS and always-on lifecycle.
- [AOSP DeviceAdminReceiver](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/app/admin/DeviceAdminReceiver.java): password failure callbacks and user scope.
- [GrapheneOS FAQ](https://grapheneos.org/faq#custom-dns) and [FAQ source](https://github.com/GrapheneOS/grapheneos.org/blob/main/static/faq.html): Private DNS precedence, probe traffic and VPN behavior.

See [validation](VALIDATION.md) for exercised behavior and physical-device gaps.
