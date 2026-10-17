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

**Automatic photos are not implemented.** The existing ordinary device-admin receiver handles eligible device/profile credential failures through Android's `WATCH_LOGIN` callbacks and records the reported failed-attempt count and last failure time. Successful credential entry resets the recorded count. This is not a promise to count all biometric failures or every form of login.

The existing `CAMERA` permission is used for invitation scanning. It does not authorize a background failed-password receiver to start capturing whenever it wants. Modern Android requires appropriate camera foreground-service authority and restricts starting such a service while the app is already in the background or after a boot broadcast.

An **explicitly armed, user-visible camera foreground service**, started while Bungee is visible and camera permission is granted, is a possible official-API design to investigate. It would need a visible notification, Android's camera privacy indicators, local off/stop controls, bounded capture attempts and private encrypted storage. It could not promise automatic rearming after reboot, force-stop, revoked permissions or camera privacy controls. Lock-screen capture eligibility, callback delivery, front-camera availability and background lifecycle behavior must be verified on a physical GrapheneOS phone before advertising that feature. This is a conditional design option, not an implemented permission toggle.

Device-owner enrollment, accessibility automation, root and shell bridges are not introduced for camera capture. Normal pairing, location sharing and other consented recovery actions do not depend on camera capture being available.

## Useful additions that fit the current recovery contract

These are candidates, not features added by this update:

| Addition | Safe, limited scope |
| --- | --- |
| Low-battery / missed-check-in alerts | Dashboard alerts derived from saved reports, with explicit timestamps and offline uncertainty. The current dashboard already displays battery and last contact. No external messaging provider is required. |
| Recovery readiness | Extend existing lock/security-patch/GPS status with reported alarm volume, notification-channel state and missing local permissions. Report facts and offer local Settings links; do not silently grant permissions. |
| Failed-credential threshold events | Record an alert when an eligible report crosses a configured threshold, such as three attempts. Offline reports arrive later; no automatic photo or destructive response is implied. |
| Geofence events | Operator-defined home areas and arrival/departure events based on saved GPS, with accuracy/late-upload handling. No network lookup service or blocking device policy is needed. |
| Temporary faster location sharing | A locally approved, time-bounded increase in Bungee's own sampling cadence, subject to GPS/background permission and battery constraints. No radio automation or persistent Android restriction. |

The existing lost mode, removable screen locking, server-held location history, privacy controls, command expiry and independent local recovery remain the supported core. Broader MDM restrictions are still subject to [the recovery contract](SAFETY.md); airplane-mode automation retains its separately documented [API boundary](AIRPLANE_MODE.md).

## Primary sources

- [Android camera foreground-service requirements](https://developer.android.com/develop/background-work/services/fgs/service-types#camera): camera permission, while-in-use restrictions and continuing eligible camera access in the background.
- [Restrictions on foreground-service starts](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start#wiu-restrictions): background and boot limits are separate from having a permission in the manifest.
- [GrapheneOS DeviceAdminReceiver](https://github.com/GrapheneOS/platform_frameworks_base/blob/ef402132a86b78aa4627daa823766e79b1f601e1/core/java/android/app/admin/DeviceAdminReceiver.java): failed/successful password callbacks and `WATCH_LOGIN` authority.
- [Android notification channels](https://developer.android.com/develop/ui/views/notifications/channels): user control over channel importance and notification behavior.
- [Android AudioAttributes](https://developer.android.com/reference/android/media/AudioAttributes#USAGE_ALARM): alarm audio usage is not a grant to override system volume or interruption settings.
