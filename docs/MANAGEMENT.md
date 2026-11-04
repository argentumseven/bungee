# Personal-device recovery and legacy management

Bungee uses removable device administration. Device-owner enrollment and persistent policies are disabled because their removal can require a reset. See [local recovery requirements](SAFETY.md).

## Current features

GPS/check-in history, recurring history lookup/export, bounded encrypted GPS backlog, sound/stop sound, recovery notifications, lost-mode contact intent and optional ordinary device-admin locking remain. Failed-credential reports depend on Android eligibility and do not count every biometric failure. App lock uses the phone's existing credential. Bungee changes no credentials or lock complexity.

The alarm uses a 30-second siren at Android's alarm volume. Recovery messages are Android notifications. Optional theft photos need one-time local approval and a visible camera service; three new eligible failed PIN/password entries trigger one attempt while ready. Optional boot recovery needs a separate opt-in and Android's Display over other apps access. After first unlock a brief startup screen restores protection and closes automatically. Physical GrapheneOS camera/restart testing is pending. See [setup and limits](RECOVERY_CONTROLS.md).

Open **Pairing & recovery** in the normal Bungee app, or use the independent **Bungee recovery** launcher if app state is damaged. Stop preserves pairing and server history. Reset pairing keeps phone keys by default; select new keys explicitly if they are damaged. Android management repair is a separate confirmed action and preserves pairing data. A saved local stop prevents automatic reconnect; a manual restart does not restore earlier camera/restart approvals. See [the exact recovery boundaries](SAFETY.md#local-recovery).

Managed system DNS/always-on, selected-app suspension, uninstall prevention, forced lock requirements, settings restrictions and remote reboot are unavailable. Their API policy fields are rejected by server and phone. There is no root, wipe, credential reset, kiosk mode, USB/ADB block, bootloader modification or silent OS enrollment.

## Airplane-mode authority

Scheduled airplane-mode cycling requires protected system networking authority that official app/MDM grants do not provide. A foreground service has the same limit. Bungee uses no shell bridge or root. See [the API analysis](AIRPLANE_MODE.md).

## Connection

The app-contained WireGuard/gVisor transport carries only Bungee's home API and leaves Android's VPN slot free. Bungee changes no system routes or DNS. Other VPNs can route or filter its outer socket. Ordinary networking remains under Android and the user's network/VPN configuration.

DNS routing, logs and relay services were removed in 1.1.17. [Upgrade cleanup](DNS-REMOVAL.md) restores settings changed by the previous version without retaining any DNS control or relay functionality.

## Legacy device-owner enrollment

Do not create an owner with ADB or OS provisioning. If you independently tested an older version as owner, preserve its original signer and data. Uninstall/clearing data/different-signature replacement can strand the management path. Explicit management repair removes known restrictions and asks Android to release Bungee's own device-owner role only after successful cleanup. It verifies the result, cannot guarantee OS acceptance, and never resets the phone or deletes profiles. See [legacy boundaries](SAFETY.md#earlier-preview-device-owner-state).

## Stable signing and updates

Install the official APK from GitHub Releases or **manager Settings → Phone app updates**. Both serve the exact same APK, with the same checksum and persistent release certificate. CI builds an unsigned release input, tests it, then signs it once in a protected main/tag release job. Pull-request jobs never receive production signing credentials. An unconfigured signer fails publication; there is no disposable-key fallback or installable workflow test APK.

The host downloads the APK for the exact running server commit, verifies its checksum, package, version, alignment and real signing certificate, then serves it unchanged. It stores the first official certificate at encrypted `volumes/tls-data/android-signing/publisher.sha256` and refuses an unexpected change. The publisher private key never reaches a household server or app container. The phone checks and downloads through its paired connection and verifies the checksum, package, newer version and installed certificate before opening Android’s confirmation screen. Local Stop, pause/resume and data-preserving routine updates remain supported.

Existing household-signed phones keep a compatibility APK made with their original encrypted `bungee.p12`/`password` key. These keys are neither replaced nor created on fresh official installations. The signed check/sync includes the installed certificate so the server selects the compatible APK. Older clients without this field continue receiving their household variant until updated. The manager’s normal download is always the unchanged official GitHub APK. Missing established household keys require restoring their encrypted backup.

Historical GitHub builds used disposable CI keys. Their private keys cannot be recovered from an APK, and the new common identity cannot retroactively match them. For those installations only, let unsent data upload, keep the existing manager device, install the official APK and use **Reconnect · keep history** on that same record. Server history is retained. Ordinary official updates do not require reinstalling or re-pairing.

### Maintainer setup for the shared release key

On a trusted administrator machine with Java `keytool`, Python 3.11+ and GitHub CLI authenticated for repository administration, run once:

```sh
python3 scripts/setup-release-signing.py
```

The helper creates a persistent PKCS12 identity outside the checkout, saves a local public certificate pin, and uploads the keystore/password directly to GitHub Actions secrets over stdin. It configures `BUNGEE_RELEASE_KEYSTORE_BASE64`, `BUNGEE_RELEASE_STORE_PASSWORD`, and the public repository variables `BUNGEE_RELEASE_SIGNER_SHA256` / `BUNGEE_RELEASE_KEY_ALIAS`. No secret is printed or committed. The default local backup directory is `~/.local/share/bungee-release-signing`; keep an encrypted offline backup of it. Re-running reuses the same identity and refuses to replace a different established certificate. `--directory` can select an existing PKCS12 key/password directory; the default alias is `bungee`.

The connected GitHub app cannot manage repository secrets. This one-time setup must run with the repository administrator’s GitHub CLI credentials. Once configured, future releases sign automatically. Never paste the private key or password into chat, issues or source. Keep GitHub administration and the release branch/tag permissions restricted to trusted maintainers.

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
