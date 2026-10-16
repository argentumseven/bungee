# Reversibility and recovery contract

Applies to alpha.6 and later. Earlier previews with device-owner controls do not meet this contract. At this audit (2026-10-16), the project owner confirmed that nothing had been deployed or enrolled.

The requirement is that a Bungee fault, lost server, lost app key or failed update must not create a new persistent restriction on the phone. Bungee must not depend on a working home server or decryptable pairing identity to let the user stop it locally. We cannot promise bug-free software or recovery from arbitrary Android, storage or hardware failures. This document specifies the narrower properties enforced in the supported personal-device mode and distinguishes tests from remaining validation.

## Supported installation and authority

Bungee is an ordinary user-installed app. It does not enroll as Android device owner or profile owner. Provisioning activities are disabled and return cancellation if invoked. The client refuses pairing, sharing, automatic restart, connecting and command execution if Android nevertheless identifies Bungee as device owner. Do not assign the role through ADB or another provisioning tool; that is unsupported and invalidates the removability assumption.

Optional ordinary device administration requests only force-lock and watch-login. It cannot prevent the user from deactivating Bungee administration in Android Settings. Bungee supplies no deactivation-veto UI or policy that blocks access to Settings or Safe Mode. Enabling optional remote-lock administration requires proving the existing primary device credential locally. Remote locking can require that PIN/password afterward and uses the phone's existing credential; Bungee never chooses, changes, resets or learns that credential. Forgotten OS credentials remain an Android recovery problem; Bungee does not offer a credential bypass.

Root, accessibility administration, privileged system installation and bootloader changes are not required. Do not install Bungee as a privileged/system app or root it; those arrangements are outside the supported model.

## Controls excluded from the product

The server and phone reject managed DNS/always-on, remotely requested restart policy, recovery-settings restrictions, uninstall prevention, forced credential complexity and package suspension. These are not merely disabled dashboard switches. Legacy stored policies are projected to the permitted recovery fields before sync; new requests cannot recreate the persistent fields. The new client rejects those fields even if an older or modified server sends them.

The server refuses reboot commands regardless of advertised legacy capability or administrator password. Previously queued pending/delivered reboot commands are rejected before polling and cannot be delivered by the new server. The new app advertises no reboot capability and contains no reboot execution branch. Reboot was removed because unattended restart and device-owner authority do not meet the current recovery requirement. Use GrapheneOS's own native settings manually if you want an OS-supported automatic reboot policy; Bungee does not configure it.

There is no remote wipe, reset-on-failed-unlocks, PIN/password reset, lock-task/kiosk mode, disabling of a launcher/keyboard/Settings, USB/ADB shutdown policy, installation restriction, account lock, encryption-key destruction, boot/firmware modification or factory-reset command. There is no automatic response that erases phone data. The app never blocks Safe Mode or Settings factory reset. It does not hide its launcher or recovery entry.

## Network and offline behavior

Only app-contained WireGuard carries Bungee's fixed home API. No Android VPN routes, system DNS setting, always-on package, VPN lockdown or default internet route is installed. A missing server or broken tunnel leaves other applications on their existing connection. Another VPN may carry/filter the outer UDP socket; Bungee does not override that VPN's policy.

A server outage does not execute a fallback device policy. It preserves timestamped history and the bounded encrypted local GPS queue. Timed-out commands expire instead of becoming permanent restrictions. Lost mode is a contact notification plus at most one attempted screen lock per revision when ordinary administration is approved; it cannot replace or cover credential entry. The local user can stop Bungee or deactivate administration. Android notification/audio/permission rules continue to apply.

## Local recovery

A separate **Bungee recovery** launcher entry opens `LocalRecoveryActivity`. It uses Android views and does not construct the encrypted Identity, Compose UI, QR decoder or native transport. Android's biometric/device-credential UI authorizes changes. If no secure screen lock exists, the phone must be unlocked and an explicit local confirmation is required. Intent extras cannot trigger cleanup or resume automatically.

**Stop Bungee and release old policies**:

1. First attempts to persist a non-secret local-stop flag in a separate preference file.
2. Stops the sharing service and cancels Bungee notifications.
3. Independently attempts removal of known old Bungee restrictions; one failure cannot skip subsequent independent cleanup.
4. On a personal installation, requests removal of ordinary device administration.
5. Displays every reported cleanup failure. If saving the stop flag fails, it does not claim the stop will survive restart; the user is directed to Android force-stop/deactivation.

The saved stop is checked before service/boot identity loading, network connection and command execution. It is not cleared by a server response, boot or app update. Stopping also atomically withdraws permission to resume after boot/update. **Allow a manual restart** requires fresh local authentication/confirmation, clears the stop, and starts no service. It never restores an earlier restart opt-in; that requires a separate fresh choice in the main app. Sharing still requires an explicit start. Normal pause uses the same stop state, so pausing does not unexpectedly resume at the next boot.

The recovery screen directly opens Android app settings and security settings. On a supported personal installation, Android's administration deactivation, force-stop and uninstall remain the final local exits if Bungee's own UI/state fails. Stop/recovery preserves pairing keys and saved server history. Explicit unpairing deletes only Bungee's own identity; server-history erasure/revocation remains a separate confirmed data-management operation. This is not an assurance that intentional deletion of Bungee records can be undone.

## Earlier preview device-owner state

No phone has been deployed by the project owner, so new installation must use the supported personal mode. The cleanup code is only a best-effort aid for anyone who separately tested an earlier preview.

Android device ownership is OS-managed. It can prevent ordinary uninstall and may require a factory reset to remove if the app/signing key or management path fails. Clearing known restrictions does not remove that role. Bungee does not call deprecated testing-only ownership removal, transfer ownership, reset the phone or discard its old pairing state as a supposed cure.

If old ownership exists, preserve the original signing key and app data. Do not uninstall, clear app data or install an APK signed with a different key as a recovery strategy. Local cleanup attempts to remove Bungee's old always-on/uninstall/complexity/Settings restrictions and owner lock-screen text. Old suspended-app names are read with the existing storage key only; no replacement key is generated. A missing key or failed Android API is reported. Android ownership remains explicit in the recovery result; the new client refuses normal operation while it remains. No successful recovery claim is made for this unsupported state.

## Required verification before household use

The API and Kotlin tests enforce forbidden-policy rejection and cleanup continuation on injected failures. Browser checks enforce the absence of dangerous controls and continued history/recovery workflows. Android emulator testing is recorded separately in VALIDATION.md when actually completed.

Physical GrapheneOS checks remain required: personal installation and removal; ordinary admin activation/deactivation; local recovery online/offline and after boot; stale server policies; app lock; notifications; denied permissions; force-stop; storage pressure; unreadable app keys/state; killed process; update with the same signing key; server loss; and another VPN. Verify that Settings, unlocking, calls, keyboard, launcher and normal connectivity remain usable. Never claim these checks passed based on compilation or a mocked policy report.

Any future control that can outlive the app or remove a local recovery path must remain unavailable until its reversal, failure handling, update behavior and OS escape route are established. Short leases or a rollback timer alone are insufficient: an OS-persisted restriction can survive a broken app that never runs its timer.
