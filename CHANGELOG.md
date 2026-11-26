# Changelog

Versions come from [`release.json`](release.json). Published APK assets include `build.json` with the exact source commit, version code, SHA-256 and signing certificate. Update the server before the matching phone app.

## 1.1.25 — Android code 41

**Phone app only.** The server is unchanged, so a 1.1.24 server works with a 1.1.25 phone and the reverse.

- **Slow links.** A hidden ten-second limit in the phone's network layer cut off any request whose response took longer, however much time the request was meant to have. Recovery-photo uploads (up to 60 seconds) and app-update chunks (now up to 30 seconds) could therefore fail on a weak connection with **home server unreachable**. Each request now keeps only its own deadline: 10 seconds for ordinary requests, 30 for an update chunk and 60 for a photo. Ordinary requests are unchanged.
- **Build only: nightly image refresh.** The scheduled "Refresh tested stable container images" run no longer fails every night when the newest release is an Android APK release. It checks the newest stable `vX.Y.Z` release, and does nothing, successfully, when there is none. It has no effect on the app, the server or signing.

## 1.1.24 — Android code 40

**Update the server first, then the APK.** A 1.1.24 app sends its focus and diagnostics fields only when the server says it supports them, but the 1.1.23 device-state reports still need a 1.1.23 or newer server.

- **Active Android profile.** Each installation reports whether its Android user is in the foreground and when its profile last became foreground, promptly on Android's user-switch broadcasts. The dashboard shows the active profile (or **Switching profiles** / **Focus unconfirmed**) and sends pictures, recovery messages and diagnostics to it by default through **Target for profile commands**, which can also name a specific profile. An automatically targeted command makes the phone recheck that its user is still foreground and reject the request rather than act in the wrong profile. An older app is accepted for picture requests only. See the [rules](docs/PROFILE-COMPANIONS.md#active-profile-and-targeted-actions).
- **Phone diagnostics.** **Check phone diagnostics** asks a profile to run local readiness checks (location services, location access, saved GPS queue, server connection, battery and power, battery-optimization exemption, storage, notifications, device administration, theft-photo protection, versions) and returns up to 16 ok / attention / info results to a **Phone diagnostics** panel. It reports settings only: no position, photo or network name. See [Phone diagnostics](docs/MANAGEMENT.md#phone-diagnostics).
- **Phone app updates.** The phone resumes an interrupted APK download from its last saved chunk, retries transient tunnel and server failures up to three times (after 1, 3 and 8 seconds; the last wait is 60 seconds if the server answered 429) and says when the server replaced the APK. The server's preparation messages, including **APK download returned HTTP 404**, are explained in [update downloads](docs/MANAGEMENT.md#how-a-phone-gets-its-update-and-what-the-messages-mean).
- **Date filters.** Activity and Sharing history filter by event time (**From (local time)**, **To (local time)**, **Apply filter**, **Clear filter**).
- **GPS purge for all phones.** **Activity → Log storage and cleanup** can purge saved GPS for every phone at once, or only points older than a chosen age (each phone's newest point is kept).
- **Layout.** Recovery photos are **Recovery captures**, a sidebar page that can be scoped to one phone or profile. **Sharing history** is a **Tracking** tab (Device care links to it). Android profile setup is under **Pairing & history → Add Android profile / Manage Android profiles**. Device care lists when airplane mode was last turned on and off. The phone app's settings use a switch for automatic recovery after reboot and full-width camera buttons, and its profile commands are named **Profile recovery commands**.
- **Host helper.** `bungee-host.py status` is read-only and works while an update, rebuild or APK preparation is running. Other host commands report that another Bungee host operation is in progress instead of failing on the lock.

## 1.1.23 — Android code 39

**Update the server first, then the APK.** The new phone reports fields an older server rejects; its queue is kept until the server is updated.

- **Backfill after an outage.** Saved GPS is sent in several bounded batches per connection cycle, sized from the upload request itself, instead of one small batch every fifteen seconds. A failed tunnel connection no longer shrinks the batch to one point, and a long backlog starts the next cycle after two seconds while the link stays healthy. A quick series of catch-up batches records one check-in.
- **Sampling in radio silence.** GPS sampling no longer depends on timers that stall while the CPU sleeps with no network traffic: each pause ends at an elapsed-realtime deadline with an idle-capable alarm, each listening window holds a short wake lock, a missed window is followed by a longer one and persistent misses back off. Physical-device behavior of Doze, alarms and GNSS without assistance data remains unverified.
- **Airplane mode, Location and permissions are recorded.** The phone observes (never changes) airplane mode, Android's Location switch, the GPS provider, location and background-location permission, and GPS gaps. Each event keeps the circumstances Android shows (locked, screen on, network gone, sharing running); Android does not say who or why. Changes found after the app was not running have an unknown time. Events are queued on the phone (bounded) and sent after reconnection.
- **Location off.** The phone shows a notification and button that open Android's location settings, reports the state, and Device care shows it with a button that sends a recovery message asking whoever holds the phone to turn Location on. No app or server can switch Location on remotely.
- **Activity.** The dashboard feed is chronological, filterable and paginated through every stored entry instead of the latest 100, and shows phone events with their circumstances at the time they happened.
- **Purge and self-trimming.** Purge saved GPS or activity entirely or by age, per phone and per kind, after a confirmation; set an optional automatic age; the server always trims the oldest rows beyond per-phone ceilings (administrator entries 20,000, phone events 10,000, and 2,000,000 each of GPS points, check-ins and IP observations) and never removes a phone's newest GPS point by age. Purges are recorded.

## 1.1.22 — Android code 38

- Photo uploads can use their intended 60-second request budget; ordinary control requests retain the shorter budget.
- A transient runtime-lease conflict pauses the armed camera instead of silently withdrawing the saved local camera consent. Readiness reports explain the pause.
- Main-profile command capabilities refresh on the next sync after a profile/camera change.
- Picture buttons use server time and consistent camera readiness checks across the phone overview and profile views. Duplicate-instance notices expire consistently with their displayed lifetime.
- Shared hardware command receipts identify a background main Android user; the dashboard warns when its recent report shows that state.

## 1.1.21 — Android code 37

- Phone-level manual pictures target the recently reported active, locally approved Android profile and name it on the button.
- Missing readiness and conflicting foreground reports have explanations; Android rejects capture for an inactive profile with a clear receipt.

## 1.1.20 — Android code 36

- Manual front-camera pictures through web recovery commands, using the existing locally armed theft-photo service and upload flow.
- Sharing start/stop history on phone and web, distinguishing manual actions, Android-reported crashes, errors and uncertain exit times.
- Temporary Locate requests can work with passive GPS sharing off under existing recovery/location consent.
- GPS history remains visible through outages, with a latest-fix-based initial range, refresh/backfill and an explicit saved-history view.

## Source builds and regular releases

The first checked APK for a new app version is a regular release. Additional main-branch builds of that same version are labelled **build snapshots** and published as prereleases, so source-built servers can fetch their exact matching APK without replacing the regular download. A newer workflow number cannot promote a lower app version. Existing historical releases retain their original labels unless separately corrected.

The stable/preview **container channel** is separate from main-branch APK publication. For an updated source checkout use:

```sh
cd /usr/local/src/bungee &&
git pull --ff-only origin main &&
sudo python3 scripts/bungee-host.py rebuild &&
sudo python3 /opt/bungee/bungee-host.py status
```

See [release publication and maintenance](docs/RELEASES.md), [installation](docs/INSTALL.md), [full release history](https://github.com/argentumseven/bungee/releases), and [validation limits](docs/VALIDATION.md).
