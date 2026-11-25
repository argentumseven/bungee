# Sharing history and temporary Locate

Available in the 1.1.20 server and phone app. Update the server before installing the matching APK.

## Phone and web history

The phone's main screen shows recent sharing events with their reason, classification and local date/time. The web GUI has **Tracking → Sharing history**, plus the same timeline in **Device care** and individual profile views. A physical phone's timeline includes its linked profiles with their names. The web timeline is paginated and ordered by server receipt; event time and receipt time are both shown.

The app records explicit Start/Stop actions, the sharing notification's Stop action, local recovery, and changes to automatic GPS sharing. Recovery starts and Android service restarts have their own labels. A manual event identifies the action/source, not the person who used the phone.

App errors, settings-storage failures and Android start restrictions are labelled **Error**. When a previously running process is found to have ended, the app queries Android's historical process-exit records for that process. Java/native crashes, an unresponsive app, low memory, permission/package changes and Android-reported user stops remain distinct. Android's recorded exit time is used when available. An unexplained service teardown is **Unknown**, and a missing exit record leaves the exact stop time unknown rather than using the later detection time as the stop time. Network loss alone never creates a manual-stop event.

Stops made while sharing is off are saved locally and sent on the next approved connection. The app does not reconnect or delay a stop just to announce it. A force-stopped app needs to be opened again before its history can be recovered and uploaded. The web GUI cannot know a fresh offline stop immediately. Events from before this update cannot be reconstructed reliably.

The phone keeps at most 128 local events: every unsent event, plus only the newest twelve the server has acknowledged (the server is the record; the phone list is only a short recent view). It sends up to 20 unacknowledged events per sync. Exact retries are deduplicated by event ID. If the local queue fills, acknowledged events make room first; only then is the oldest unsent event removed, counted and reported. A server copy can already exist when only an acknowledgement was lost. The server keeps at most 10,000 events per phone, removing the oldest, and an administrator can purge or age out the log (see [Activity](#activity-log)). Full history erasure rotates a separate generation so old queued events cannot restore the erased timeline; GPS-only erasure leaves it intact. Disconnecting preserves the timeline, while revoke-and-erase and archive deletion remove it. Local recent history is independent of server erasure; resetting Bungee pairing also clears its local sharing history.

Only fixed reason codes and timestamps are uploaded to the household server. No crash dumps, stack traces or Android exit descriptions are uploaded. These are phone-reported diagnostics, not hardware-attested proof of a person's actions.

## Temporary GPS from recovery commands

**Refresh location** performs one bounded GPS attempt even when automatic GPS sharing is off. **Best guess** can use its existing longer bounded attempt. The request uses the phone's existing recovery-command approval and precise location permission. When its location service is not already active, background-location permission is needed to start the temporary GPS operation remotely.

The automatic-sharing setting is left unchanged. The GPS listener is removed after completion, failure or cancellation, and a temporary foreground-service promotion is restored afterward. Temporary GPS attempts and their outcome are included in sharing history. Stop all actions cancels an in-flight request.

A locally stopped app or offline phone must reconnect before it can receive a command. This feature cannot override a saved local stop, grant Android permissions, enable Android's global Location switch, or start GPS inside a linked companion that is restricted to profile-local actions. A command still expires after five minutes and is not repeated after an interrupted execution claim.

Automated coverage checks classification, timestamps, local persistence/acknowledgements, bounded queues, erasure generations, profile isolation, pagination, stale runtime reports, temporary-GPS consent rules and desktop/mobile views. Actual Android process termination and GPS hardware remain physical-device checks.

## Device-state events

While the sharing service runs, the phone records changes in:

| Event | Meaning |
| --- | --- |
| Airplane mode turned on / off | `Settings.Global.AIRPLANE_MODE_ON` changed |
| Location turned off / on | Android's master Location switch changed |
| GPS provider disabled / enabled | The GPS provider changed while the master switch stayed on |
| Location permission removed / granted | Precise location permission changed |
| Background location removed / granted | The "all the time" grant changed (not repeated when precise access itself was lost) |
| GPS fixes stopped / resumed | Five misses in a row over at least five minutes while GPS was otherwise available, and the first fix afterwards |

Android does not report **who or what** changed a setting, which control was used, or why. Each event therefore carries only the circumstances Bungee could see: whether the phone was locked, whether the screen was on, whether airplane mode or Location was also off, whether Bungee sharing was running and whether the default network had gone, and (for gaps) the number of missed attempts and minutes. These flags are fixed on both sides; the server rejects any other field, so no coordinate, network name or free text can be attached. A locked phone does not identify a thief and an unlocked phone does not identify its owner.

A change is seen live from Android's broadcasts and a check about once a minute. If a setting changed while Bungee was not running, the next start records the difference with **time unknown**, marked as found after Bungee was not running, instead of claiming a time. A rapidly flapping switch is limited to twelve recorded events per ten minutes; the baseline is not advanced for a held-back change, so the final state is still reported, and the next event notes how many changes were skipped. Events are sent after reconnection and shown at the time they happened, labelled **Reported after reconnecting** when they arrive much later.

## Activity log

**Activity** lists administrator actions and phone events together, newest first, with filters for one phone or one kind of event and a **Load older activity** button; nothing is capped at the latest hundred. The server keeps up to 20,000 administrator entries and 10,000 events per phone and trims the oldest automatically. **Log storage and cleanup** shows row counts and database size, can purge activity or saved GPS by age or entirely (each phone and each kind separately, after a confirmation), and can apply an automatic age. A purge is itself recorded. A full activity purge rotates the phone's event generation so unsent events cannot restore it; an age purge keeps newer entries and does not store older late events again. A GPS purge by age keeps the phone's newest point, leaves the phone's GPS generation alone so its offline backlog still uploads, and never reaches photos or check-ins.
