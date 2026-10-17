# Recovery controls and feasible additions

## Alarm

The updated **Sound alarm** command plays a rising/falling siren using Android's alarm audio usage for up to 30 seconds. The audio is bundled locally; it needs no media provider or network fetch. The phone resource contains exactly 30 seconds of audio and is not looped indefinitely. A separate app timer and local-consent checks can stop it earlier. The player is released on completion, error, stop, consent withdrawal or service teardown. Audio preparation happens before taking the consent/stop locks; permission and command deadlines are checked again before starting sound.

This does not change the phone's volume, routing, Do Not Disturb settings or notification policy. A muted alarm stream, interruption settings, audio routing or an Android/audio failure can prevent an audible result. A command receipt reports an attempted start, not proof that a person heard it. Stop it through the dashboard, **Stop sound** on Bungee's phone notification, local recovery, or Android's app controls. Disabling household commands stops active playback at the next local check. A local stop also stops the service.

**Preview alarm sound** in the dashboard plays one two-second cycle in the browser. It queues no command. The updated APK uses the same waveform for its bounded 30-second resource; earlier APKs retain their older beep pattern. `scripts/generate-alarm.py` reproduces both assets. Their durations, PCM format, peak bounds and shared waveform are checked during this change; actual speaker volume, routing, interruption behavior and process-loss behavior still require physical-device verification.

## How the message appears

An ordinary recovery message is a high-priority Android notification titled **A message from your household**, with up to 240 characters and an expanded-text layout. Lost mode uses **Lost phone · contact the household**. Both request public lock-screen visibility and an ongoing notification. The recovery notification channel initially has high importance; Android and the user control its actual importance, sound, lock-screen visibility and heads-up eligibility. Existing user changes to a channel are not overridden.

There is no full-screen intent, screen overlay, replacement lock screen or automatic opening of an activity. A heads-up banner may briefly appear while the phone is in use if Android permits it. On the lock screen it uses the system notification area, leaving credential entry to Android. Notification denial or privacy settings can hide the message. Android may allow a notification to be dismissed independently of Bungee's saved message; Bungee does not force it over the user's UI.

The message is also saved in Bungee and can be dismissed after local unlock or cleared from the server. The dashboard's **Phone preview** offers illustrative lock-screen and heads-up layouts using the typed text. The same component previews lost-mode text. These previews are web illustrations, not captures of a real Android device, and do not queue commands or change policies. Exact rendering depends on Android version, theme, font size, notification settings and the device.

## Three failed unlocks and a front-camera photo

Version 1.1.0 implements an **optional, locally armed Camera2 foreground service**. This is ordinary official Android camera authority, not a system-permission bypass. It adds no third-party bridge, root, shell/ADB dependency, accessibility automation, device owner, microphone, camera stream or provider. Camera access remains optional for pairing by pasted invitation, GPS sharing and normal recovery commands.

### Arm on the phone

1. Set an Android secure screen lock. Pair with the updated server, start Bungee sharing and separately approve household commands.
2. Use **Enable removable device administration** for Android's eligible `WATCH_LOGIN` credential callbacks. This remains ordinary removable administration, with force-lock/watch-login only.
3. Grant Bungee camera permission and allow its notifications. The armed-camera notification channel must also be enabled. Bungee checks for a front camera.
4. Choose **Review & arm locally**, read the consent explanation and authenticate with the existing phone lock. Bungee must be visible and the phone unlocked when it starts the `camera` foreground service. A short-lived, process-local approval is consumed by that start.
5. The notification says **Bungee recovery camera is armed** and offers **Disarm camera**; its action requests Android authentication when the phone is locked. Camera indicators and Android's foreground-service controls remain available. Dismissing the notification requests disarm. The app can stay in the background after a permitted foreground start; the camera is opened only for a capture attempt.

There is no persisted armed flag, server arm command, automatic boot/replacement arm, sticky service restart or receiver that starts a camera service. Reboot, force-stop, process loss or denied foreground start leaves camera mode disarmed. Normal sharing's separate restart opt-in never arms the camera. Re-arming requires another local approval and replaces any old unsent photo queue.

### Capture and failure limits

The OS-protected receiver handles eligible device/profile credential failures for this Android user. A successful credential entry resets the streak. A new arming starts from the OS count at arming, so it requires **three new failed entries**, not an old threshold. The app does not promise to count biometric failures or every form of login.

Within each armed service session, Bungee attempts at most one capture per qualifying streak, no closer than five minutes apart and at most six attempts per rolling hour. The local **Take a labelled test photo** action uses the same budget and marks its photo `local_test`; it is not presented as a failed-unlock event. An unavailable camera still consumes the streak's attempt; no capture loop retries it. Actual failed-unlock capture requires the phone still to be locked, while a local test requires it unlocked and Bungee visible.

Camera acquisition/capture has an eight-second coroutine timeout and closes the image reader, capture session and camera on completion, error or cancellation. Idle armed mode holds no open camera. Capture uses no flash or microphone. Permission/admin/notification loss or stopping sharing disarms the service. Local stop, command-consent withdrawal and disarm cancel capture/send reservations; a stale operation cannot commit to the queue after re-arming. Bytes already sent to home cannot be recalled.

Android camera privacy controls, another app's camera use, background restrictions, battery policies, hardware or GrapheneOS rules may prevent an image or yield blank output. Arming is not proof that a usable photo can be captured. The public SDK does not expose a general unprivileged camera-privacy-state query; Bungee does not use a hidden API to bypass that boundary. No OS lock screen, credential, radio, routing or persistent management policy is changed. An armed camera service **cannot change airplane mode**; see [the authority boundary](AIRPLANE_MODE.md).

### Private storage and viewing

The original camera JPEG is processed in memory, resized to a longest edge of 320 pixels (160 if needed), decoded/re-encoded to strip EXIF and bounded to **12 KiB**. These deliberately small recovery images are not high-resolution evidence. Android stores up to **three unsent photos** under the existing Keystore AES-256-GCM storage encryption; the oldest is discarded at capacity and the dropped count is reported. Disarming clears pending queue state; cleanup failures are surfaced. After abrupt process loss, any encrypted remnants are never sent by an unarmed process and are replaced at the next explicit arm. Deletion is logical, not a forensic block-erasure promise.

Photos use signed `/v1/telemetry` requests over the existing fixed-home app-contained WireGuard transport. Each is sent separately from GPS batches, keeping the existing 32-KiB body limit and native path allowlist. Camera/photo failures have a separate retry delay and do not block ordinary GPS reporting. No provider fetch, runtime dependency or network endpoint is added to the phone. A unique photo ID allows exact-content retry acknowledgment; conflicting reuse is rejected. The server independently permits at most six new photo records per device per rolling hour.

**Device care → Recovery photos → View saved photos** loads an administrator-authenticated, paginated gallery from this server only. Nothing loads until the section is opened. Photos and their timestamps are separate from ordinary device-list telemetry. Responses use `image/jpeg`, `nosniff` and `no-store`; list/image access is bound to the enrolled, unrevoked phone. The gallery shows captured/received time, eligible failure count or the local-test label. These are signed app reports, not hardware-attested facts or proof of theft.

Server photos stay until explicitly erased, full history erasure or device revocation; they have no automatic expiry. **Erase all recovery photos** requires confirmation and rotates a photo-specific opaque generation transactionally. Old queued/in-flight generations cannot restore erased photos; a new generation can accept later captures. Location-only erasure leaves photos alone. Full history erasure rotates both generations. Authenticated URLs for erased/revoked records stop serving them; already viewed/downloaded copies cannot be recalled. SQLite and updater snapshots require encrypted host storage/backups; the administrator can read uploaded photos. This is not end-to-end encryption against your own server administrator.

### Physical GrapheneOS acceptance — not performed in this cloud

Use a personally owned removable installation with the same signing key. First arm while visible and use **Take a labelled test photo**; check its label, image, capture/receipt times and gallery authentication. A passing local test does **not** establish locked/background capture. Separately verify eligible PIN/password callbacks, locking and the three-new-failure threshold, while respecting Android's credential retry delays. Never change or remove the phone's credential for this test.

Check front-camera access when locked/backgrounded, privacy toggles and another camera app, denied permissions/notifications/admin, notification disarm/dismissal, local stop offline, command-consent withdrawal during capture/upload, Doze and radio loss, encrypted queue capacity, erasure during a delayed upload, force-stop/process loss, reboot/first unlock and same-signer APK update. Confirm that none re-arms automatically and that Settings/deactivation/uninstall remain usable. This feature is implemented and build/API/browser/policy-tested; physical GrapheneOS capture and endurance are **not claimed as passed**.

## Useful additions that fit the current recovery contract

These are candidates, not features added by this update:

| Addition | Safe, limited scope |
| --- | --- |
| Low-battery / missed-check-in alerts | Dashboard alerts derived from saved reports, with explicit timestamps and offline uncertainty. The current dashboard already displays battery and last contact. No external messaging provider is required. |
| Recovery readiness | Extend existing lock/security-patch/GPS status with reported alarm volume, notification-channel state and missing local permissions. Report facts and offer local Settings links; do not silently grant permissions. |
| Standalone failed-credential alerts | Add configurable dashboard alerts without requiring camera mode. Existing counts and the armed photo trigger are separate; offline reports arrive later. |
| Geofence events | Operator-defined home areas and arrival/departure events based on saved GPS, with accuracy/late-upload handling. No network lookup service or blocking device policy is needed. |
| Temporary faster location sharing | A locally approved, time-bounded increase in Bungee's own sampling cadence, subject to GPS/background permission and battery constraints. No radio automation or persistent Android restriction. |

The existing lost mode, removable screen locking, server-held location history, privacy controls, command expiry and independent local recovery remain the supported core. Broader MDM restrictions are still subject to [the recovery contract](SAFETY.md); airplane-mode automation retains its separately documented [API boundary](AIRPLANE_MODE.md).

## Primary sources

- [Android camera foreground-service requirements](https://developer.android.com/develop/background-work/services/fgs/service-types#camera): camera permission, while-in-use restrictions and continuing eligible camera access in the background.
- [Restrictions on foreground-service starts](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start#wiu-restrictions): background and boot limits are separate from having a permission in the manifest.
- [GrapheneOS DeviceAdminReceiver](https://github.com/GrapheneOS/platform_frameworks_base/blob/ef402132a86b78aa4627daa823766e79b1f601e1/core/java/android/app/admin/DeviceAdminReceiver.java): failed/successful password callbacks and `WATCH_LOGIN` authority.
- [Android notification channels](https://developer.android.com/develop/ui/views/notifications/channels): user control over channel importance and notification behavior.
- [Android AudioAttributes](https://developer.android.com/reference/android/media/AudioAttributes#USAGE_ALARM): alarm audio usage is not a grant to override system volume or interruption settings.
