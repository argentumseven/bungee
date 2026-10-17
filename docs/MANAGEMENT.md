# Personal-device recovery and legacy management

Current builds enforce the [reversibility contract](SAFETY.md). Device-owner enrollment and operation are unsupported because Android cannot guarantee owner removal without a reset. Earlier MDM features are disabled rather than advertised as safely reversible.

## Current features

GPS/check-in history, recurring history lookup/export, bounded encrypted GPS backlog, sound/stop sound, recovery notifications, lost-mode contact intent and optional ordinary device-admin locking remain. Failed-credential reports depend on Android eligibility and do not count every biometric failure. App lock uses the phone's existing credential. Bungee changes no credentials or lock complexity.

The updated finder alarm uses a bounded 30-second siren at the phone's alarm volume. Recovery messages remain Android notifications, with illustrative previews in the web message/lost-mode editors. An optional, locally armed camera foreground service attempts a photo after three new eligible failed credential entries. Local authentication and a visible notification are required; Android can refuse capture. No remote arming, root, shell bridge or device ownership is used. Physical GrapheneOS camera acceptance remains unverified. See [recovery behavior, camera limits and feasible additions](RECOVERY_CONTROLS.md).

The separate **Bungee recovery** launcher works offline without pairing keys. Authenticate locally, stop controls, review cleanup results and use Android app/security settings if needed. The saved local stop survives process/boot/update and prevents automatic reconnect. Clearing it starts no sharing; a manual start is still required. Personal installs remain removable through normal Android administration deactivation and uninstall.

Managed system DNS/always-on, selected-app suspension, uninstall prevention, forced lock requirements, settings restrictions and remote reboot are unavailable. Their API policy fields are rejected by server and phone. There is no root, wipe, credential reset, kiosk mode, USB/ADB block, bootloader modification or silent OS enrollment.

## Airplane-mode authority

Official app/MDM permissions do not provide the requested scheduled airplane-mode-off/report/airplane-mode-on cycle on the checked GrapheneOS implementations. Eligible management authority can prohibit airplane mode and force it off; removing that restriction does not restore it on. The direct two-way API requires protected system networking authority. The selected scope excludes a shell/ADB bridge, so no C2 radio toggle is added. A locally armed foreground service does not grant this protected authority. Ordinary lower-permission operation remains available. See the [verified API boundary and primary sources](AIRPLANE_MODE.md).

## Connection and DNS

The app-contained official WireGuard/gVisor transport carries only Bungee's home API and leaves Android's VPN slot free. Bungee changes no system routes/DNS. Other VPNs can route or filter its outer socket. Ordinary networking remains under the user's Android/VPN configuration.

The server retains legacy DNS rollup/read/erase and forwarding code for prior-version compatibility/tests. New phones cannot enroll in managed DNS or enable it through the API. Leave BUNGEE_DNS_UPSTREAM_IP empty for new deployments. Existing summaries are five-minute registrable-site groups with folded 10-second activity windows, not app-attributed browsing history. No raw subdomain/answer/payload log is added. Any separately configured legacy private resolver controls its own logging/upstreams.

<a id="existing-owner-from-an-older-preview"></a>

## Legacy device-owner enrollment

Do not create an owner with ADB or OS provisioning. If you independently tested an older version as owner, preserve its original signer and data. Uninstall/clearing data/different-signature replacement can strand the management path. The new recovery entry attempts removal of known restrictions; it cannot guarantee removal of Android's owner role and will not automatically reset the phone. See [legacy boundaries](SAFETY.md#earlier-preview-device-owner-state).

## Stable signing and updates

Use the same signing key for in-place app updates. CI debug keys may change; personal installs may require uninstall/re-pair when signatures differ, losing Bungee's local identity/backlog. This does not require erasing the phone in the supported personal mode. Back up needed Bungee records before intentionally uninstalling. Never enroll a CI debug APK as owner.

For your own stable release signer, create/back up a private keystore on a trusted development machine outside the checkout. Example with interactive passwords:

```sh
keytool -genkeypair -keystore /secure/offline/bungee-owner.jks \
  -alias bungee -keyalg EC -groupname secp256r1 -validity 3650
export BUNGEE_OWNER_KEYSTORE=/secure/offline/bungee-owner.jks
bash scripts/build-transport.sh
bash scripts/build-owner-apk.sh
```

The historical helper name `build-owner-apk.sh` refers to an operator-owned signing key; it does not enable device ownership. It signs/lints an optimized release, verifies the public certificate and prints SHA-256. Keep its key/password private; do not put them in source, issues or chat. Optional BUNGEE_OWNER_KEY_ALIAS/KEY_PASSWORD select an existing key. Increase versionCode on updates and verify the public signer fingerprint. Hosted production signing and an automatic update service are not implemented.

## Primary sources

- [AOSP DevicePolicyManager](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/app/admin/DevicePolicyManager.java): owner lifecycle, policy release, force-lock and permission contracts.
- [AOSP DeviceAdminReceiver](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/app/admin/DeviceAdminReceiver.java): ordinary administration and credential events.
- [AOSP VpnService](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/net/VpnService.java): system VPN authority and routing.
- [Official WireGuard netstack](https://github.com/WireGuard/wireguard-go/blob/2631ce99a06f27120d581611cf125d68bc6aa565/tun/netstack/tun.go): pinned app-contained transport.
- [GrapheneOS auto reboot](https://grapheneos.org/features#auto-reboot) and [USB protection](https://grapheneos.org/features#usb-c-port-and-pogo-pins-control): native OS settings, not Bungee-managed policies.
