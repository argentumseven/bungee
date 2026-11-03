# Personal-device recovery and legacy management

Bungee uses removable device administration. Device-owner enrollment and persistent policies are disabled because their removal can require a reset. See [local recovery requirements](SAFETY.md).

## Current features

GPS/check-in history, recurring history lookup/export, bounded encrypted GPS backlog, sound/stop sound, recovery notifications, lost-mode contact intent and optional ordinary device-admin locking remain. Failed-credential reports depend on Android eligibility and do not count every biometric failure. App lock uses the phone's existing credential. Bungee changes no credentials or lock complexity.

The alarm uses a 30-second siren at Android's alarm volume. Recovery messages are Android notifications. Optional theft photos need one-time local approval and a visible camera service; three new eligible failed PIN/password entries trigger one attempt while ready. Optional boot recovery needs a separate opt-in and Android's Display over other apps access. After first unlock a brief startup screen restores protection and closes automatically. Physical GrapheneOS camera/restart testing is pending. See [setup and limits](RECOVERY_CONTROLS.md).

Open **Pairing & recovery** in the normal Bungee app, or use the independent **Bungee recovery** launcher if app state is damaged. Stop preserves pairing and server history. Reset pairing keeps phone keys by default; select new keys explicitly if they are damaged. Android management repair is a separate confirmed action and preserves pairing data. A saved local stop prevents automatic reconnect; a manual restart does not restore earlier camera/restart approvals. See [the exact recovery boundaries](SAFETY.md#local-recovery).

Managed system DNS/always-on, selected-app suspension, uninstall prevention, forced lock requirements, settings restrictions and remote reboot are unavailable. Their API policy fields are rejected by server and phone. There is no root, wipe, credential reset, kiosk mode, USB/ADB block, bootloader modification or silent OS enrollment.

## Airplane-mode authority

Scheduled airplane-mode cycling requires protected system networking authority that official app/MDM grants do not provide. A foreground service has the same limit. Bungee uses no shell bridge or root. See [the API analysis](AIRPLANE_MODE.md).

## Connection and DNS

The app-contained official WireGuard/gVisor transport carries only Bungee's home API and leaves Android's VPN slot free. By default Bungee changes no system routes/DNS. The optional [Private DNS controller](DNS.md) requires an ADB grant and separate local approval; it uses no VPN slot or device-owner policy. Other VPNs can route or filter its outer socket. Ordinary networking remains under the user's Android/VPN configuration.

The server retains legacy DNS rollup/read/erase and forwarding code for prior-version compatibility/tests. New phones cannot enroll in managed DNS or enable it through the API. The same explicit home resolver can also serve the optional [public DoT relay](DNS.md); configuring an upstream alone does not enable phone-wide DNS. Existing summaries are five-minute registrable-site groups with folded 10-second activity windows, not app-attributed browsing history. No raw subdomain/answer/payload log is added. Any separately configured legacy private resolver controls its own logging/upstreams.

<a id="existing-owner-from-an-older-preview"></a>

## Legacy device-owner enrollment

Do not create an owner with ADB or OS provisioning. If you independently tested an older version as owner, preserve its original signer and data. Uninstall/clearing data/different-signature replacement can strand the management path. Explicit management repair removes known restrictions and asks Android to release Bungee's own device-owner role only after successful cleanup. It verifies the result, cannot guarantee OS acceptance, and never resets the phone or deletes profiles. See [legacy boundaries](SAFETY.md#earlier-preview-device-owner-state).

## Stable signing and updates

Install the APK from **manager Settings → Phone app updates**. The host automatically downloads the checked public APK for the exact running server commit, verifies its checksum/package/version, and signs it with a persistent household key. Bungee’s phone screen checks for updates through the paired connection and offers Download/Install. It shows installed and server versions, separate checking/downloading/verifying states, downloaded bytes and percentage, pause/resume, and host preparation failures. A check can open the app-contained connection without enabling GPS sharing; local Stop remains authoritative. Background policy sync does not replace a paused download or its error message. Android asks for installation permission and confirmation. Pairing keys, preferences and queued GPS survive in-place updates. No Android VPN slot is used.

The private signing key/password live in encrypted `volumes/tls-data/android-signing`, included in existing authenticated cold backups, outside the runtime container mounts. Keep that key when restoring or moving a server. A missing established key is an error; the host never silently replaces it. The host worker retries unavailable releases and keeps at most two signed APKs.

If an APK previously issued by this same server reports a signing-key mismatch, first restore its original `volumes/tls-data/android-signing` identity from the encrypted backup. Repeated checks cannot change the phone’s installed certificate; do not reinstall while investigating a missing server key.

Older GitHub builds used disposable CI signing keys. Android requires one reinstall to move to the server’s certificate; the lost private key cannot be recovered from the old APK. Let any local backlog upload first. If removable Android administration is enabled, turn it off before uninstalling. Keep the manager’s saved device, then choose **Reconnect · keep history** with the new app’s public key. This rotates the invitation and authentication keys while preserving the same logical device ID, GPS, IP history and photos. Use server-issued APKs for future updates; reinstalling is unnecessary. Never enroll an APK as device owner.

For your own stable release signer, create/back up a private keystore on a trusted development machine outside the checkout. Example with interactive passwords:

```sh
keytool -genkeypair -keystore /secure/offline/bungee-owner.jks \
  -alias bungee -keyalg EC -groupname secp256r1 -validity 3650
export BUNGEE_OWNER_KEYSTORE=/secure/offline/bungee-owner.jks
bash scripts/build-transport.sh
bash scripts/build-owner-apk.sh
```

The historical helper name `build-owner-apk.sh` refers to an operator-owned signing key; it does not enable device ownership. It signs/lints an optimized release, verifies the public certificate and prints SHA-256. Keep its key/password private; do not put them in source, issues or chat. Optional BUNGEE_OWNER_KEY_ALIAS/KEY_PASSWORD select an existing key. Increase versionCode on updates and verify the public signer fingerprint. An independently signed APK can only update APKs using that same independent certificate; it cannot switch signing identities in place.

## Primary sources

- [AOSP DevicePolicyManager](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/app/admin/DevicePolicyManager.java): owner lifecycle, policy release, force-lock and permission contracts.
- [AOSP DeviceAdminReceiver](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/app/admin/DeviceAdminReceiver.java): ordinary administration and credential events.
- [AOSP VpnService](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/net/VpnService.java): system VPN authority and routing.
- [Official WireGuard netstack](https://github.com/WireGuard/wireguard-go/blob/2631ce99a06f27120d581611cf125d68bc6aa565/tun/netstack/tun.go): pinned app-contained transport.
- [GrapheneOS auto reboot](https://grapheneos.org/features#auto-reboot) and [USB protection](https://grapheneos.org/features#usb-c-port-and-pogo-pins-control): native OS settings, not Bungee-managed policies.

For device/profile ownership, pending administration removal and partial-pairing recovery, see [the removal audit](REMOVAL_AUDIT.md). **Check administration status** in local recovery distinguishes ownership from ordinary administration.
