# Sharing history and temporary Locate

Available in the 1.1.20 server and phone app. Update the server before installing the matching APK.

## Phone and web history

The phone's main screen shows recent sharing events with their reason, classification and local date/time. The web GUI has **Tracking → Sharing history**, plus the same timeline in **Device care** and individual profile views. A physical phone's timeline includes its linked profiles with their names. The web timeline is paginated and ordered by server receipt; event time and receipt time are both shown.

The app records explicit Start/Stop actions, the sharing notification's Stop action, local recovery, and changes to automatic GPS sharing. Recovery starts and Android service restarts have their own labels. A manual event identifies the action/source, not the person who used the phone.

App errors, settings-storage failures and Android start restrictions are labelled **Error**. When a previously running process is found to have ended, the app queries Android's historical process-exit records for that process. Java/native crashes, an unresponsive app, low memory, permission/package changes and Android-reported user stops remain distinct. Android's recorded exit time is used when available. An unexplained service teardown is **Unknown**, and a missing exit record leaves the exact stop time unknown rather than using the later detection time as the stop time. Network loss alone never creates a manual-stop event.

Stops made while sharing is off are saved locally and sent on the next approved connection. The app does not reconnect or delay a stop just to announce it. A force-stopped app needs to be opened again before its history can be recovered and uploaded. The web GUI cannot know a fresh offline stop immediately. Events from before this update cannot be reconstructed reliably.

The phone retains the latest 128 local events and sends up to 20 unacknowledged events per sync. Exact retries are deduplicated by event ID. If the local queue fills, its oldest event is removed; unacknowledged removals are counted and reported. A server copy can already exist when only an acknowledgement was lost. Server events have no automatic expiry. Full history erasure rotates a separate generation so old queued events cannot restore the erased timeline; GPS-only erasure leaves it intact. Disconnecting preserves the timeline, while revoke-and-erase and archive deletion remove it. Local recent history is independent of server erasure; resetting Bungee pairing also clears its local sharing history.

Only fixed reason codes and timestamps are uploaded to the household server. No crash dumps, stack traces or Android exit descriptions are uploaded. These are phone-reported diagnostics, not hardware-attested proof of a person's actions.

## Temporary GPS from recovery commands

**Refresh location** performs one bounded GPS attempt even when automatic GPS sharing is off. **Best guess** can use its existing longer bounded attempt. The request uses the phone's existing recovery-command approval and precise location permission. When its location service is not already active, background-location permission is needed to start the temporary GPS operation remotely.

The automatic-sharing setting is left unchanged. The GPS listener is removed after completion, failure or cancellation, and a temporary foreground-service promotion is restored afterward. Temporary GPS attempts and their outcome are included in sharing history. Stop all actions cancels an in-flight request.

A locally stopped app or offline phone must reconnect before it can receive a command. This feature cannot override a saved local stop, grant Android permissions, enable Android's global Location switch, or start GPS inside a linked companion that is restricted to profile-local actions. A command still expires after five minutes and is not repeated after an interrupted execution claim.

Automated coverage checks classification, timestamps, local persistence/acknowledgements, bounded queues, erasure generations, profile isolation, pagination, stale runtime reports, temporary-GPS consent rules and desktop/mobile views. Actual Android process termination and GPS hardware remain physical-device checks.
