# Local recovery requirements

Applies to the current release and to versions from alpha.6 onward. Earlier versions with device-owner controls do not meet this contract.

A Bungee fault, unavailable server, lost app key or failed update must leave local stop and ordinary Android removal available. The independent recovery entry works without the server or pairing identity. These requirements apply to Bungee controls; Android, storage and hardware faults can still prevent recovery.

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
2. Independently disarms/stops the camera, attempts pending-photo cleanup, stops sharing and cancels Bungee notifications.
3. Independently attempts removal of known old Bungee restrictions; one failure cannot skip subsequent independent cleanup.
4. On a personal installation, requests removal of ordinary device administration.
5. Displays every reported cleanup failure. If saving the stop flag fails, it does not claim the stop will survive restart; the user is directed to Android force-stop/deactivation.

The saved stop is checked before service/boot identity loading, network connection and command execution. It is not cleared by a server response, boot or app update. Stopping also atomically withdraws permission to resume after boot/update. **Allow a manual restart** requires fresh local authentication/confirmation, clears the stop, and starts no service. It never restores an earlier restart opt-in; that requires a separate fresh choice in the main app. Sharing still requires an explicit start. Normal pause uses the same stop state, so pausing does not unexpectedly resume at the next boot.

The recovery screen directly opens Android app settings and security settings. On a supported personal installation, Android's administration deactivation, force-stop and uninstall remain the final local exits if Bungee's own UI/state fails. Stop/recovery preserves pairing keys and saved server history. Explicit unpairing deletes only Bungee's own identity; server-history erasure/revocation remains a separate confirmed data-management operation. This is not an assurance that intentional deletion of Bungee records can be undone.

<a id="earlier-preview-device-owner-state"></a>

## Legacy device-owner state

New installations use the supported personal mode. The cleanup code is a best-effort aid for earlier versions that enabled device ownership.

Android device ownership is OS-managed. It can prevent ordinary uninstall and may require a factory reset to remove if the app/signing key or management path fails. Clearing known restrictions does not remove that role. Bungee does not call deprecated testing-only ownership removal, transfer ownership, reset the phone or discard its old pairing state as a supposed cure.

If old ownership exists, preserve the original signing key and app data. Do not uninstall, clear app data or install an APK signed with a different key as a recovery strategy. Local cleanup attempts to remove Bungee's old always-on/uninstall/complexity/Settings restrictions and owner lock-screen text. Old suspended-app names are read with the existing storage key only; no replacement key is generated. A missing key or failed Android API is reported. Android ownership remains explicit in the recovery result; the new client refuses normal operation while it remains. Removal of legacy ownership remains unverified on a phone.

## Required verification before household use

The API and Kotlin tests enforce forbidden-policy rejection and cleanup continuation on injected failures. Browser checks enforce the absence of dangerous controls and continued history/recovery workflows. Android emulator testing is recorded separately in VALIDATION.md when actually completed.

Physical GrapheneOS checks remain required: personal installation and removal; ordinary admin activation/deactivation; local recovery online/offline and after boot; stale server policies; app lock; notifications; denied permissions; force-stop; storage pressure; unreadable app keys/state; killed process; update with the same signing key; server loss; and another VPN. Verify that Settings, unlocking, calls, keyboard, launcher and normal connectivity remain usable. Record physical results separately from builds and fixture reports.

Any future control that can outlive the app or remove a local recovery path must remain unavailable until its reversal, failure handling, update behavior and OS escape route are established. Short leases or a rollback timer alone are insufficient: an OS-persisted restriction can survive a broken app that never runs its timer.

## Optional automatic theft photos

The optional `camera` foreground service uses one locally authenticated, persistent opt-in. Initial and restored visible starts require an unlocked resumed activity; system sticky restarts require an encrypted same-boot checkpoint. Eligible failed-credential callbacks only notify a live service; a server command cannot activate it. No owner role, root or shell bridge is introduced.

Optional **Automatic recovery after reboot** requires a second local opt-in and Android's revocable **Display over other apps** special access. A boot/update receiver may then request a bounded real startup activity after first Android unlock. That activity resumes the approved camera service and closes without user interaction. It is non-exported, no-history, absent from recents, never shown over the lock screen and uses no overlay, transparent window, credential prompt or navigation restriction. A durable claim precedes the one automatic launch attempt per boot/app version. Failed launches do not retry in a UI loop; a twelve-second activity close deadline and attention fallback bound the normal failure path. No private key or photo is moved out of credential-encrypted storage. Force-stop and Android app controls remain effective exits.

Disarm, local stop, command withdrawal and ordinary-administration deactivation disable both camera choices and independently cancel pending startup, stop capture and clear checkpoints/unsent photos. Local recovery initializes no Identity or camera hardware and continues other cleanup when a step fails. Clearing local stop does not restore either opt-in. Disabling only automatic boot recovery leaves current protection alone; revoking the Android special access removes future background-launch authority. Unexpected process/connection-service loss preserves authorized data for permitted recovery and never overrides withdrawal. Camera mode and the additional activity permission cannot change airplane mode. See [behavior and unperformed physical acceptance](RECOVERY_CONTROLS.md).

## Server updates

The host-only Compose updater replaces the three images as one bundle. It stages downloads, closes outside admission, snapshots all five cold volumes, validates a candidate and restores failed trials before reopening. Acceptance is journaled for both success and rollback so subsequent recovery cannot replay a snapshot over newly admitted telemetry. This changes no phone ownership, credentials, permissions, firmware or APK. Local phone recovery remains independent of server health. Failed server restoration stays closed for console repair, with snapshots preserved; arbitrary disk/host failure is not guaranteed recoverable. See [the update contract](INSTALL.md).

## Connectivity failures

Network callbacks, monotonic retries, independent GPS sampling and bounded uploads affect only Bungee's app-contained connection. No radio/airplane-mode setting or persistent OS policy is added. Local stop cancels the native peer's active requests; retry cannot clear the stop flag. Encrypted command reservations precede action; lost receipts are retried without re-executing a reserved command. A crash can leave an explicitly unknown outcome. Server acceptance of a dated late receipt does not reauthorize expired commands. Queue capacity is surfaced rather than hidden, and storage failure creates no fallback phone restriction. See [DDIL.md](DDIL.md).

## Restart location permission

Automatic GPS recovery after first unlock requires precise and background location permission, explicitly granted through Android Settings, plus the sharing restart opt-in or standing theft-photo opt-in. The grant is optional and can be revoked normally. Without it, automatic restart can reconnect in a connection-only foreground service and reports GPS paused; open Bungee and resume GPS from the visible screen. A blocked foreground-service start posts an attention notification when notifications are allowed. No identity or GPS access is promised before first unlock. Physical GrapheneOS cold-boot/lock/Doze acceptance is still open; see [the review follow-up](REVIEW-2026-10.md).

## Command consent and storage failure

Household commands, including remote fresh-location requests, are off until separately explained/approved with local phone unlock. Old implicit command-consent preferences do not authorize the new build. Permission checks and a shared guard precede command/lost-mode actuation. Consent or app-lock writes must succeed before the UI reports success. A failed command write vetoes the current process and attempts independent local-stop persistence/service shutdown. If storage rejects that too, the UI directs the user to Android force-stop; the stop may not survive process death. App-lock write failures keep the current session locked and expose an error. See [the second review](REVIEW-2026-10-SECOND.md) for physical fault tests still required.


## Cancellation and restart

Stop sharing persists the independent local stop. The stopped screen says **Open local recovery to resume**: authenticate there, allow a manual restart, then explicitly start sharing. No server response can clear this stop. GPS/command withdrawal and local stop invalidate earlier capture/send stamps and cancel active reservations; bytes already sent may still reach home. A local-safety write failure keeps a process veto and surfaces Android force-stop guidance. Persistent storage failure still prevents guarantees after process death. GPS erasure uses a transactional server generation rather than a handset timestamp cutoff. See [the adversarial review record](REVIEW-2026-10-ADVERSARIAL.md) for the precise limits and required physical tests.
