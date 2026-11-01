# Recovery controls

## Alarm

**Sound alarm** plays the bundled rising/falling siren for up to 30 seconds using Android's alarm audio stream. It saves the current alarm-stream volume, raises it to maximum for playback, and restores it on completion, error or stop. A recovery checkpoint also restores volume on the next service launch after an interrupted process. Routing and interruption settings, including Do Not Disturb, still apply. A muted stream or audio failure can make it inaudible.

Stop it from the dashboard, **Stop alarm** in the phone notification after unlocking, local recovery or Android app controls. Withdrawing command consent also stops playback. The player is released on completion, error, cancellation or service teardown. An execution receipt confirms the app attempted playback; it cannot confirm that anyone heard it.

**Preview alarm sound** plays one two-second cycle in the browser without sending a command. The phone repeats the same waveform for its 30-second resource. `scripts/generate-alarm.py` reproduces both assets.

**Alarm + flash** and **Flash only** optionally blink the rear camera flashlight at one cycle per second for up to 30 seconds. Camera permission and flash hardware must be available; camera contention can prevent this. Stopping releases the torch. A personal removable app cannot guarantee that lock-screen system controls, hardware buttons, force-stop or shutdown cannot silence it; Bungee does not intercept those exits.

## Recovery messages

Messages are Android notifications with up to 240 characters. Ordinary messages use **A message from your household**; lost mode uses **Lost phone · contact the household**. The channel initially requests high importance, public lock-screen visibility and an ongoing notification. Android and the user determine actual importance, sound, visibility and heads-up behavior. Existing channel choices are preserved.

Messages use the system notification area and leave credential entry accessible. Bungee does not use a full-screen intent, overlay or replacement lock screen. Android may hide or dismiss a notification independently of Bungee's saved message. The message also appears inside Bungee, where it can be dismissed after local unlock, or cleared from the server.

The dashboard's **Phone preview** illustrates lock-screen and heads-up layouts using your typed text. It sends no command. Actual appearance depends on the phone's Android version, theme, text size and notification settings.

## Automatic theft photos

Enable protection on the phone before it is lost. While ready, Bungee attempts one front-camera photo after three new eligible failed PIN/password entries in a row. It uses a locally approved Camera2 foreground service with a visible notification. Camera access is optional; ordinary pairing, GPS and recovery commands work without it.

**Physical GrapheneOS camera and boot-recovery testing is pending.** Android can deny camera access or return a blank image. Follow the device checks below before relying on this feature.

### Initial setup

1. Set a secure Android screen lock. Pair Bungee, start sharing and approve household commands.
2. Choose **Enable removable device administration**. Android's force-lock/watch-login grant enables screen locking and eligible credential callbacks.
3. Grant camera permission and allow notifications, including the camera-protection channel. The app checks for a front camera.
4. Choose **Enable theft photos** and authenticate with the phone lock. Keep Bungee visible and the phone unlocked for the initial service start.
5. Wait for **Ready** and **Bungee camera is armed**. Starting or enabled-but-not-ready states do not indicate usable capture.

Approval stays saved until withdrawn. The server cannot enable it remotely. Idle protection holds no camera open. **Disarm camera** in the notification requests Android authentication when locked. The sharing notification's **Stop sharing** action does too; **Stop alarm** also requires unlock. Swiping away a notification does not disarm protection. Android's own app/service controls remain available.

### Restore after reboot or an app update

Separately choose **Enable automatic boot recovery**, authenticate and grant Android's **Display over other apps** special access. Both the local choice and system grant are required. This is a broad, revocable permission; Bungee uses its background activity-launch exception to open a brief startup screen.

After Android's first normal unlock, **Restoring theft protection** restores the approved camera service and closes automatically. No tap or new camera-consent dialog is needed. The screen is a normal visible activity, can be closed with **Close screen** or Back/Home, and has a twelve-second close timer. It draws no overlay, covers no lock screen, requests no startup credentials and does not block navigation.

The boot receiver requests the screen; only its resumed, unlocked activity can start the camera foreground service. A saved claim precedes launch, with one automatic attempt per boot/app version. Duplicate events, failed launches and consumed/expired offers cannot cause repeated startup windows. A pending request can wait for unlock. Failure posts an attention notification when possible.

Turning off automatic boot recovery cancels pending launches while keeping current camera/sharing consent. Revoking special access removes background-launch authority. Without these grants, opening Bungee while unlocked resumes standing camera consent. Force-stop can require a manual launch in either mode. Pairing keys and checkpoints remain credential-encrypted and unavailable before first unlock. Unsent pictures exist only in RAM.

### Process recovery and capture limits

Android may restore the service through `START_STICKY`. An encrypted checkpoint from the same boot retains the session, failure streak and rate budget; unsent photos are lost on process exit. Successful-credential callbacks can reset a saved streak before the service returns, without starting it. Missing, corrupt, future or cross-boot checkpoints cannot authorize a background restart.

A new visible session takes the current OS failure count as its baseline and requires three new failures. Same-boot restoration preserves that baseline. Successful credential entry resets the streak. Android's watch-login callbacks cover eligible device/profile credentials for this user; biometric failures and other app logins may be excluded.

After each capture attempt, another three new failed credential entries can trigger a further attempt. Attempts are at least 30 seconds apart and capped at 20 per rolling hour, including failed acquisitions and local tests. Repeated callbacks without new credential entries cannot trigger more pictures. This is event-driven; no timer-driven capture retry loop runs. **Take a labelled test photo** shares the rate budget and records `local_test`. Failed-unlock capture requires the phone locked; the local test requires Bungee visible and unlocked.

Capture has an eight-second timeout and closes the camera, reader and session on completion, error or cancellation. It uses no flash or microphone. Camera privacy controls, another camera app, background/battery restrictions and hardware availability can prevent output.

Disarm, local stop, command withdrawal and administration deactivation disable camera recovery and cancel pending startup/capture/uploads. They clear unsent photos and checkpoints; cleanup failures are reported. Clearing local stop does not restore old consent. Connection-service loss preserves RAM-held pictures while the process lives; process exit discards unsent pictures. Withdrawal invalidates earlier prepared work even after re-enabling; bytes already transmitted cannot be recalled.

### Photo storage and erasure

The app selects the largest suitable bounded front-camera output, then briefly prepares automatic exposure, white balance and supported continuous autofocus using discarded metering frames. If metering streams are unsupported it falls back to a single still capture. Pictures target a 2048-pixel long edge at JPEG quality 90, with up to 3,145,728 output pixels and a 1 MiB JPEG limit. Encoding can fall back to quality 85/80 and 1600/1280 pixels to stay within the limit. EXIF is removed by decoding/re-encoding. Large source images are subsampled before bitmap allocation, and an encoder output buffer retains at most 1 MiB even when a trial encoding is too large. The phone keeps up to eight unsent images in RAM, without writing new JPEGs to disk. At capacity the oldest is discarded and the loss count is reported. Queue content is at most 8 MiB of JPEG-equivalent data; Base64, objects, network serialization and temporary image buffers use additional bounded memory. Total phone RAM is not the app heap budget.

With camera consent still enabled, the connection uploads queued photos separately from GPS, even if the camera service is temporarily unavailable, through signed `/v1/photos` requests over the fixed-home WireGuard transport. Photo failures have their own retry delay. The dedicated photo route accepts at most 2 MiB of JSON and a 60-second request deadline; ordinary telemetry/control routes retain 32 KiB and ten seconds. The native path allowlist enforces both limits independently. At most two photo request bodies are admitted at once on the server, each with an independent 75-second deadline so a stalled sender cannot keep its slot indefinitely. Exact-content retries acknowledge the same photo ID; conflicting reuse is rejected. The server admits at most 28 new photos per device per rolling hour, allowing an eight-image offline queue to catch up alongside the phone’s 20 attempts/hour.

**Device care → Recovery photos → View saved photos** opens an authenticated, paginated gallery. Images load only when opened, from the home server, with `image/jpeg`, `nosniff` and `no-store`. The gallery records capture/receipt times and failure count or local-test label. Signed reports have no hardware attestation and do not establish a person's identity or prove theft. Camera status is dated; an offline phone's present state is unknown.

Photos remain on the server until separately erased, full history is erased, or the phone is revoked. GPS-only erasure leaves them intact. Photo erasure rotates an independent generation, rejecting earlier queues and in-flight uploads. On reconciliation the phone discards the old-generation queue; newly captured photos may arrive afterward. Deletion is logical and does not scrub filesystem blocks or backups. Encrypt server storage and backup copies.

## Physical-device checks

Use a personal test phone with a stable signer. Record the GrapheneOS build, permissions and actual timestamps. Keep Android Settings and the main app’s Pairing & recovery button accessible. Do not change the phone's credential or assign device ownership.

| Check | Expected result |
| --- | --- |
| Local test | Labelled image, capture/receipt times and authenticated gallery. This checks unlocked capture only |
| Failed PIN/password entries | Three new eligible failures trigger one attempt; a successful unlock resets the streak. Respect Android retry delays |
| Camera unavailable | Privacy toggle, camera contention and denied permission produce a reported failure without a capture loop |
| Process loss | Sticky restoration retains the queue, failure streak and rate budget |
| Reboot/update | After first Android unlock, both grants allow restoration without a Bungee tap. Test delayed unlock and same-signer updates |
| Startup failures | Duplicate events, blocked launches, revoked access, storage faults and process death around the saved claim do not create repeated windows; manual recovery remains available |
| Startup UI | Credential entry stays accessible, large text scrolls, Back/Home/Close work and the close timer runs |
| Force-stop | Automatic recovery stays stopped until manual launch |
| Network/Doze | Test locked capture, radio loss, another VPN, battery behavior, queue capacity and later uploads |
| Erasure/withdrawal | Delayed uploads cannot restore erased generations; disarm, command withdrawal and local stop cancel pending work and stay disabled after restart |
| Removal | Notification authentication, independent offline recovery, Settings, administration deactivation and uninstall remain usable |

[VALIDATION.md](VALIDATION.md) lists completed automated checks. [ROADMAP.md](ROADMAP.md) lists possible additions.

## Primary sources


- [Android camera foreground-service requirements](https://developer.android.com/develop/background-work/services/fgs/service-types#camera): camera permission, while-in-use restrictions and continuing eligible camera access in the background.
- [Restrictions on foreground-service starts](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start#wiu-restrictions): background and boot limits are separate from having a permission in the manifest.
- [Android background activity-launch exceptions](https://developer.android.com/guide/components/activities/background-starts): a user-granted `SYSTEM_ALERT_WINDOW` permits activity launch. [Checked GrapheneOS controller](https://github.com/GrapheneOS/platform_frameworks_base/blob/ef402132a86b78aa4627daa823766e79b1f601e1/services/core/java/com/android/server/wm/BackgroundActivityStartController.java) retains the explicit user-grant check; this is source evidence, not a physical boot test.
- [Android Direct Boot storage](https://developer.android.com/privacy-and-security/direct-boot): credential-encrypted storage becomes available only after first user unlock. Bungee does not relocate its keys/photos to bypass this.
- [Android START_STICKY contract](https://developer.android.com/reference/android/app/Service#START_STICKY): system restoration of an existing service is distinct from an app initiating a new background service. [Checked GrapheneOS implementation](https://github.com/GrapheneOS/platform_frameworks_base/blob/ef402132a86b78aa4627daa823766e79b1f601e1/services/core/java/com/android/server/am/ActiveServices.java) retains the existing service record through system restart; this source check is not physical-device acceptance.
- [GrapheneOS DeviceAdminReceiver](https://github.com/GrapheneOS/platform_frameworks_base/blob/ef402132a86b78aa4627daa823766e79b1f601e1/core/java/android/app/admin/DeviceAdminReceiver.java): failed/successful password callbacks and `WATCH_LOGIN` authority.
- [Android notification channels](https://developer.android.com/develop/ui/views/notifications/channels): user control over channel importance and notification behavior.
- [Android AudioAttributes](https://developer.android.com/reference/android/media/AudioAttributes#USAGE_ALARM): alarm audio usage is not a grant to override system volume or interruption settings.

## Capture and delivery diagnostics

“Camera armed” means ready to observe a trigger, not that a photo was captured. The phone shows the new failed-PIN/password streak (up to 3), capture result and upload errors; Device care shows the last signed report and pending capture timestamps/reasons. Android resets the streak after a successful credential unlock; biometric failures may not count. The app observes Android’s own counter as a fallback for delayed admin broadcasts, without guessing failures. A labelled local test while unlocked separates camera permission/hardware failures from lock-screen restrictions.

Photos are resized and stripped of EXIF metadata, held in RAM only (maximum eight), uploaded independently of whether the camera service is currently armed, then removed after server acknowledgement. Upload errors wait at least ten seconds before the next connection cycle; normal network backoff still applies. No JPEG is written to phone preferences/files. Updating adopts readable pictures from the old encrypted queue into RAM before removing their disk copy. Existing pictures keep their IDs and can still be delivered; unreadable migration data is preserved with an error. New pictures are never written to disk. Process death, disarm or local stop discards unsent images. A photo upload failure does not block normal telemetry. The dedicated photo HTTP request is capped at 60 seconds in both the Kotlin caller and native transport and run before potentially long GPS commands.

The gallery supports erasing one photo, all photos for a device, or all household photos from Tracking → Photos. Single deletion retains an ID tombstone so a retry cannot resurrect that photo; bulk erasure rotates photo generations. Existing server backups/media blocks are unaffected by logical deletion.

Queued commands can be canceled individually on the device page. Commands already offered may be executing; Stop retries prevents future redelivery, and updated phones recheck immediately before beginning an action. Cancellation cannot recall an action that has started. Late receipts are retained with the cancellation result.

## Stop current actions

**Stop all Bungee actions** is an actuation stop, including a siren already playing or torch already blinking. It restores Bungee's temporary alarm-volume change, cancels current remote work and pending/offered older commands, clears the recovery message, and disables lost mode/haste. A separate stop poll runs every two seconds while remote actions/alarms/messages/lost mode are active, independently of long GPS waits and photo uploads. Delivery still requires connectivity. The stop request remains available for 24 hours; ordinary action requests expire after five minutes. Receipts distinguish requested, offered and actually completed stops.

The normal app connection, locally approved sampling, phone keys and permissions remain intact. This is not an Android unlock command. Lock uses only `DevicePolicyManager.lockNow()` and ordinary removable force-lock permission: no credential reset, wipe, owner restriction or remote unlock. Stop invalidates a queued lock; once Android has locked the screen the user unlocks normally.

## Camera trigger diagnostics

Both Android credential-callback overloads are accepted and deduplicated by the OS failure count. The camera service also observes that counter. A third eligible failure during the shared test/automatic cooldown remains eligible once the cooldown ends while the phone stays locked; no fourth failure is required. Duplicate observations cannot capture again without three more failures. A successful unlock cancels that eligibility and an in-flight automatic capture. Callback failures and camera busy/disabled/configuration failures now have visible status text. Tests cover these counter/cooldown rules, but capture while locked still requires physical-phone validation.

Saved photos open automatically in the manager; the optional Hide control remains. The phone has one launcher icon, and Pairing & recovery is a real button on the main screen and app lock screen. The internal offline recovery panel also handles damaged pairing keys.

## DNS path checks

Bungee does not take Android's VPN slot or capture browser DNS. Android-reported resolver addresses and Private DNS state are configuration evidence only. Test home DNS path sends a fixed `example.com` A query over the signed Bungee API to the configured home resolver (for example AdGuard Home at 10.10.20.3), bypassing the retired device-owner DNS gate. The result identifies whether the upstream replied, and the server records a labelled diagnostic group. AdGuard sees the forwarding Bungee server's source address. Phone-wide browsing DNS requires separately configured Wi-Fi DNS or reachable Android Private DNS/AdGuard TLS; this feature does not claim to collect that traffic.
