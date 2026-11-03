# Local recovery requirements

Applies to the current release and to versions from alpha.6 onward. Earlier versions with device-owner controls do not meet this contract.

A Bungee fault, unavailable server, lost app key or failed update must leave local stop and ordinary Android removal available. The recovery panel works without the server or pairing identity. These requirements apply to Bungee controls; Android, storage and hardware faults can still prevent recovery.

## Supported installation and authority

Bungee is an ordinary user-installed app. It does not enroll as Android device owner or profile owner. Provisioning activities are disabled and return cancellation if invoked. The client refuses pairing, sharing, automatic restart, connecting and command execution if Android identifies Bungee as device owner or profile owner, or the role queries fail. Do not assign the role through ADB or another provisioning tool; that is unsupported and invalidates the removability assumption.

Optional ordinary device administration requests only force-lock and watch-login. It cannot prevent the user from deactivating Bungee administration in Android Settings. Bungee supplies no deactivation-veto UI or policy that blocks access to Settings or Safe Mode. Enabling optional remote-lock administration requires proving the existing primary device credential locally. Remote locking can require that PIN/password afterward and uses the phone's existing credential; Bungee never chooses, changes, resets or learns that credential. Forgotten OS credentials remain an Android recovery problem; Bungee does not offer a credential bypass.

Root, accessibility administration, privileged system installation and bootloader changes are not required. Do not install Bungee as a privileged/system app or root it; those arrangements are outside the supported model.

## Controls excluded from the product

The server and phone reject managed DNS/always-on, remotely requested restart policy, recovery-settings restrictions, uninstall prevention, forced credential complexity and package suspension. These are not merely disabled dashboard switches. Legacy stored policies are projected to the permitted recovery fields before sync; new requests cannot recreate the persistent fields. The new client rejects those fields even if an older or modified server sends them.

The server refuses reboot commands regardless of advertised legacy capability or administrator password. Previously queued pending/delivered reboot commands are rejected before polling and cannot be delivered by the new server. The new app advertises no reboot capability and contains no reboot execution branch. Reboot was removed because unattended restart and device-owner authority do not meet the current recovery requirement. Use GrapheneOS's own native settings manually if you want an OS-supported automatic reboot policy; Bungee does not configure it.

There is no remote wipe, reset-on-failed-unlocks, PIN/password reset, lock-task/kiosk mode, disabling of a launcher/keyboard/Settings, USB/ADB shutdown policy, installation restriction, account lock, destruction of the phone’s encryption keys, boot/firmware modification or factory-reset command. There is no automatic response that erases phone data. The app never blocks Safe Mode or Settings factory reset. It does not hide its launcher or recovery entry.

## Network and offline behavior

Only app-contained WireGuard carries Bungee's fixed home API. By default no Android VPN routes, system DNS setting, always-on package, VPN lockdown or default internet route is installed. The separately approved [Private DNS controller](DNS.md) is an optional exception for the DNS setting only. A missing server or broken tunnel leaves other applications on their existing connection. Another VPN may carry/filter the outer UDP socket; Bungee does not override that VPN's policy.

A server outage does not execute a fallback device policy. It preserves timestamped history and the bounded encrypted local GPS queue. Timed-out commands expire instead of becoming permanent restrictions. Lost mode is a contact notification plus at most one attempted screen lock per revision when ordinary administration is approved; it cannot replace or cover credential entry. The local user can stop Bungee or deactivate administration. Android notification/audio/permission rules continue to apply.

## Local recovery

**Pairing & recovery** is available inside the normal Bungee phone app, including
when its saved identity cannot be opened. One launcher icon leads to the main app;
Pairing & recovery is a button on both its main screen and app lock screen. It needs no pairing key, server response,
QR decoder or newly initialized native transport to open. Local biometric/device
credentials authorize changes; an unlocked phone without a screen lock uses an
explicit confirmation. Intent extras cannot trigger changes.

- **Stop Bungee** saves the local stop, closes an existing connection, stops
  sharing, disarms the camera and clears unsent photos/notifications. It preserves
  pairing keys, queued GPS and server history, and restores any Bungee-controlled DNS setting. It changes no device-owner policies.
- **Allow manual start · keep pairing** clears only the local stop after checking
  Android ownership. It starts no services and restores no camera/restart consent.
  A paired phone can also resume sharing directly in the normal app.
- **Reset pairing** separately confirms deletion of Bungee's local invitation,
  queued GPS/photos/receipts and sharing approvals. It keeps phone keys by default.
  **Generate new phone keys too** explicitly discards Bungee's own keys and works
  without decrypting a corrupt identity. Android administration and permissions,
  the phone's PIN, other apps, and saved server records are unchanged. Ordinary
  device administration does not block this app-only reset. New pairing always
  needs a fresh invitation; reset never starts sharing automatically.
- **Repair Bungee Android management** separately confirms known legacy-policy
  cleanup and release of this app's own administration/device-owner role. Pairing
  data is preserved. A profile-owner or unknown status never triggers role
  removal, profile deletion, phone reset or key regeneration.

A failed stop or changed/unknown owner status prevents pairing erasure. A failed
erasure or new-key initialization cannot clear the saved stop. Reset invalidates
old request stamps and identity generations so a stale pairing operation cannot
publish its old registration after reset. Android app/security settings remain
available if local storage or an OS API fails. Normal launch after a saved stop
stays in Bungee; it does not force users into a destructive recovery flow.

<a id="earlier-preview-device-owner-state"></a>

## Legacy device-owner state

Device/profile ownership is not created by current Bungee. The explicit repair
first stops Bungee and releases its known old policies. Only if cleanup succeeds
and Android still identifies Bungee as device owner does it call Android's
self-release API, `clearDeviceOwnerApp`, then verify the role and ordinary
administration. This deprecated API can be refused by the OS; success is not
inferred from the call returning. Failed or unconfirmed cleanup preserves pairing
keys and reports the remaining state. It never transfers ownership, wipes a
phone, deletes a profile, or calls test-only ADB owner removal.

Profile ownership is reported separately because removing a managed profile can
delete its data. This repair does not attempt it. Preserve the original signer
and app data while Android ownership remains; do not uninstall or clear app data
as an improvised fix. Missing old encryption keys or unreadable suspended-app
records are reported before attempting device-owner release. Physical
Android/GrapheneOS owner-release verification is still outstanding.

## Server pairing cleanup

In **Settings → Inactive pairings**, purge a revoked device or an expired,
never-redeemed invitation to release its public-key binding and remaining records.
A paired phone is still in use even when offline. Purge rejects live invitations
and non-revoked paired phones; explicitly revoke first when retiring a pairing.
Eligibility is rechecked inside the database transaction, so enrollment winning
a race with purge protects that newly paired device. Old tokens, device IDs and
preshared secrets are never revived: reuse of a phone public key requires a fresh
invitation with a new device ID and secrets. Purge leaves the phone unchanged.

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

## Removal audit

[REMOVAL_AUDIT.md](REMOVAL_AUDIT.md) records ownership, asynchronous deactivation, pairing cancellation, service/permission failures and OS removal paths. A foreground-service task-manager Stop ends current execution; use Bungee local stop for a saved opt-out across boot/update. Android can require ordinary administration deactivation before offering force-stop or uninstall.


## Explicit optional Private DNS

The optional ADB-approved controller is distinct from the rejected device-owner `managed_dns` policy. It needs a reachable public DoT hostname/certificate, the revocable development permission, and local phone approval. The separate DNS monitor cannot take Android's VPN slot or depend on GPS/camera permissions. Saved undo state is independent of pairing keys; failed restoration blocks pairing erasure. Off restores prior DNS, while the selected failure fallback restores Automatic and remains latched until retry. Manual Android DNS changes pause automatic control. Planned removal restores and verifies DNS before clearing approval/recovery data. The host requires restoration confirmation before removing a relay; offline restoration can be explicitly confirmed and audited by its administrator.

Private DNS is an OS-persisted setting. A dead/force-stopped/uninstalled app cannot run its watchdog or cleanup; revoking its grant before restoration can also prevent automatic recovery. This optional mode therefore does not guarantee normal connectivity under those conditions. Restore through Bungee before removal, or select Automatic in Android Private DNS settings/ADB directly. Android Settings remains available. Public service prerequisites and physical validation still pending are documented in [DNS.md](DNS.md) and [VALIDATION.md](VALIDATION.md).
