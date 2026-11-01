# Removal and recovery audit

This audit covers the current personal-app installation, Android ownership, partial pairing, background services and local recovery. It combines source inspection, Android/GrapheneOS framework references and regression tests. Physical GrapheneOS removal and fault testing is pending.

## Findings corrected in 1.1.4

| Finding | Correction | Verification |
| --- | --- | --- |
| The ownership guard checked device owner but omitted profile owner | Both roles block pairing, sharing, camera start, automatic restart, commands, unpairing and clearing local stop. Running sampling, connection and actuation paths recheck the role. A failed role query also blocks operation. Recovery identifies the role without deleting a user/profile or removing ownership | Production role classifier tests cover ordinary, device-owner, profile-owner and failed-query paths. Android binder behavior still needs a phone |
| Administration removal was reported as complete when its asynchronous request returned | Cleanup waits up to 2.5 seconds between status checks and succeeds only after Android reports administration inactive. A pending/refused/failed removal is shown explicitly. A separate status button checks both ownership and active administration | Tests cover delayed completion, silent refusal, absent administration, API failure and interrupted waiting with continued cleanup |
| Local stop depended on the sharing service to close the peer, leaving a pairing-only connection outside that path | Recovery has a process-local close callback registered only after a peer exists. It closes that peer without constructing Identity or loading a backend on a clean process. Pairing, polling and receipt requests now use cancelable reservations too. Enrollment completion and connection publication check the original consent generation | Tests cover pairing-only stop, stop/re-enable during connection creation, stale publication, close failure and later retry. Existing native tests exercise real request/peer cancellation |
| An undelivered camera-start request could retain an expired approval and block later starts | Approvals expire after five seconds. A later start can obtain a fresh approval; a delayed old intent cannot consume it. Disarm cancels the approval | Expiry, replacement, delayed intent, replay, reversed time and explicit cancellation tests |

## Ownership and installation

Pairing creates a Bungee server identity and app-private keys. It does not grant Android device/profile ownership. The ordinary administration dialog grants force-lock/watch-login only. Both provisioning activities are disabled and return cancellation; the app invokes no owner-assignment API.

An external privileged provisioning tool or older build can still assign ownership to an Android administration receiver. Android refuses ordinary removal of device/profile owners, including a removal call that returns without an exception. Bungee cannot promise reset-free removal of that state. The current build blocks normal operation and preserves its identity; it does not reset the phone, delete a profile, transfer ownership or invoke test-only owner removal. Explicit confirmed management repair can ask Android to release Bungee device ownership after successful legacy cleanup and verifies the result; profile ownership stays untouched.

The supported installation is an ordinary personal app. Root/system installation, a modified OS or another MDM's uninstall restrictions have different removal rules. Bungee does not create those conditions or have authority to override them.

## Failure paths

| Condition | Result and remaining removal path |
| --- | --- |
| Pairing never started, expired invitation or invalid QR | No Android ownership is created. Remove the app normally; an unused server invitation is separate |
| Pairing interrupted, response lost, server registration committed first | Server/app registration can disagree. Retry confirms the same signing key. Local stop cancels pending exchanges and closes an existing peer; Android removal needs no server response |
| Ordinary administration active | Android can require deactivation before uninstall/force-stop or clearing app storage. Recovery requests deactivation and verifies it. Use Android security settings if it remains active |
| Admin removal delayed or silently refused | Cleanup shows pending/unconfirmed state; it does not erase identity and claim success. Check status or use Android's removal UI |
| Bungee is device/profile owner | Ordinary uninstall can be blocked by Android. Preserve signer/data and inspect the OS management state. No destructive recovery is automatic |
| Owner status unavailable | Normal operation and manual restart remain blocked. Recovery/Settings links stay available; unknown status is not reported as removable |
| Keys lost, encrypted identity corrupt or native transport broken | Independent recovery uses no Identity, Compose, QR decoder or fresh native initialization. Existing transport close is attempted only through an already registered callback; other cleanup continues after exceptions |
| Recovery UI crashes or its main thread stalls | Use Android Settings directly. Bungee overrides no deactivation-warning/veto callback. The checked OS administration-uninstall path has its own fallback if the app callback does not finish; this does not make an externally assigned owner removable |
| Local-stop preference write fails | A process veto blocks current work and the failure is displayed. Failed persistent storage cannot guarantee the stop after process death. Use Android administration deactivation and force-stop/uninstall |
| Cleanup operation throws | Remaining independent actions are attempted and failures displayed. A blocked kernel/binder/native call can still stall an app cleanup step; exceptions tests do not establish a hard deadline for those calls. Android's own removal path is independent |
| Process killed during cleanup | A successfully saved local stop takes priority on restart. Cleanup may be incomplete; rerun recovery or remove through Settings |
| Individual feature switched off | Stops that feature's work; it does not automatically revoke Android camera/location/special-access grants or ordinary administration needed by other features. Revoke grants in Settings or uninstall. Full local recovery also deactivates ordinary administration |
| Saved local stop followed by boot/update | Android may briefly start the manifest receiver/process. The saved stop prevents sharing, camera, commands and automatic startup; the receiver itself disappears on uninstall |
| Boot/update/repeated unlock events | Restart requires saved consent and an allowed role. Camera startup claims one attempt per boot/app version, consumes a short-lived offer and uses a normal closeable screen with a twelve-second timer |
| Camera/privacy/notification/admin permission withdrawn | Camera prerequisites fail; protection becomes unavailable. Explicit administration deactivation also attempts camera disarm. It creates no OS restriction or permanent camera ownership |
| Camera-start callback delayed or absent | Expired approval can be replaced; an old callback cannot consume the replacement |
| Settings force-stop | Android stops execution and applies package stopped-state rules. The app cannot run cleanup callbacks after its process is killed. Administration may need deactivation before force-stop is offered |
| Android foreground-service task-manager Stop | Ends current execution but is not a saved Bungee opt-out. Android does not apply the full force-stop behavior; a later boot/update can resume existing consent. Use Bungee's local stop for durable withdrawal |
| Server lost, revoked phone or tunnel blocked | No fallback phone policy is installed. A revoked/offline phone can keep retrying and retain local consent until stopped locally. Revocation alone is not a local stop or uninstall |
| Server sends persistent restrictions or reboot | Server/client reject those fields/actions. Only explicit legacy cleanup removes known old policies |
| App lock enabled, app keys lost or app state corrupt | Main UI can be inaccessible. Separate recovery and Android administration/settings remain the removal path when Android authentication is available |
| Screen already locked by Bungee | Unlock with the existing PIN/password. App removal does not unlock the phone or clear Android's requirement for primary authentication after an administrative lock |
| Repeated approved lock requests | A trusted/compromised server can request new locks while commands and administration remain enabled. Local stop blocks further actions. If requests interrupt recovery, disconnect networking or use Android Safe Mode, then deactivate administration; Bungee does not block those paths. Physical usability under repeated locks remains a required test |
| Alarm/message active during removal | Audio is bounded to its 30-second resource, has no runtime loop and changes no volume/DND setting. Notifications are app-owned. OS process/package removal ends app execution; physical timing remains untested |
| Another VPN active | Bungee creates no Android VPN profile, routes, DNS or always-on policy. Removing it leaves the other VPN's configuration alone |
| Existing Android PIN/password forgotten | Recovery still requires Android authentication. If Android requires that credential, Bungee cannot unlock the phone or promise reset-free access to Settings. Remote-lock administration initially requires proving the primary credential; it never creates a replacement |
| Installer offers archive/disable instead of uninstall | Those actions can preserve app data and consent. Choose actual uninstall for removal; a saved Bungee local stop still takes precedence if an archived/disabled copy returns |
| APK update fails or signing key differs | Android rejects the replacement; the old personal installation remains. Deactivate ordinary administration and uninstall if changing signer. Ownership, if externally assigned, needs separate recovery |
| App installed in several Android users/profiles | Removal is scoped by Android user/profile. Another installed copy is independent; remove each copy if desired. Bungee requests no cross-user authority |
| CA certificate manually imported, server data, CSV or backups | These exist separately from the app. Remove/revoke/erase them explicitly if desired. Uninstall does not promise forensic deletion of OS logs or old storage blocks |

## Stop, re-pair or remove

Open the **Pairing & recovery** button in Bungee (also available on its app lock screen). **Stop
Bungee** preserves pairing and server history and changes no Android policy.
To reconnect from scratch, confirm **Reset pairing**; select fresh phone keys
only if desired or if the old keys cannot be opened. Ordinary administration
need not be removed for this app-only reset. True device/profile ownership or an
unknown role blocks key erasure until resolved.

For old Android policies, use the separately confirmed **Repair Bungee Android
management** and review its results. It attempts known-policy cleanup, then
self-release of verified Bungee device ownership; it never deletes a managed
profile or wipes the phone. A failed/pending OS operation is not reported as
success. Preserve data/signer while ownership remains. Normal personal installs
can still deactivate administration and uninstall in Android Settings.

In manager **Settings → Inactive pairings**, purge explicitly revoked records or
expired, never-paired invitations before reusing their phone keys. Live
invitations and offline paired phones are not purgeable. Re-enrollment creates
new invitation/PSK/device identity; old credentials stay invalid. Server history
erasure/revocation remains separate from the local phone reset.

Physical owner-release, phone reset/corrupt-key lifecycle and post-reboot
network/camera/unlock checks remain required on a test phone. Automated tests
cover the reset/repair decisions and server eligibility, not Android binder
behavior on every OS build.

## Sources

- [GrapheneOS DevicePolicyManager](https://github.com/GrapheneOS/platform_frameworks_base/blob/ef402132a86b78aa4627daa823766e79b1f601e1/core/java/android/app/admin/DevicePolicyManager.java): `removeActiveAdmin` explicitly documents asynchronous completion; device/profile-owner queries.
- [GrapheneOS DevicePolicyManagerService](https://github.com/GrapheneOS/platform_frameworks_base/blob/ef402132a86b78aa4627daa823766e79b1f601e1/services/devicepolicy/java/com/android/server/devicepolicy/DevicePolicyManagerService.java): `removeActiveAdmin` refuses device/profile owners; `uninstallPackageWithActiveAdmins` rejects owners and includes a ten-second fallback before launching ordinary package uninstall. That fallback applies to the OS uninstall path and is not a blanket timeout on every app-initiated removal request.
- [GrapheneOS Settings app controls](https://github.com/GrapheneOS/platform_packages_apps_Settings/blob/749748aaef77cdd2a62cce7de0ee0db30a4efafa/src/com/android/settings/applications/appinfo/AppButtonsPreferenceController.java): `updateForceStopButton` disables force-stop while package administration is active. [Administration removal UI](https://github.com/GrapheneOS/platform_packages_apps_Settings/blob/749748aaef77cdd2a62cce7de0ee0db30a4efafa/src/com/android/settings/applications/specialaccess/deviceadmin/DeviceAdminAdd.java) invokes the system administration/uninstall path.
- [GrapheneOS ActivityManagerService](https://github.com/GrapheneOS/platform_frameworks_base/blob/ef402132a86b78aa4627daa823766e79b1f601e1/services/core/java/com/android/server/am/ActivityManagerService.java): `stopAppForUserInternal` stops current execution without the full package force-stop operation.

The source references explain the OS behavior inspected. They do not establish execution on a particular phone/build. See [VALIDATION.md](VALIDATION.md) for tests and [SAFETY.md](SAFETY.md) for recovery requirements.
