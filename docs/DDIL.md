# Denied, disrupted, intermittent and limited connectivity

Bungee queues GPS during outages and retries its home connection with bounded backoff. Commands and receipts take priority over catch-up uploads. A radio blackout, blocked WireGuard UDP, a powered-off phone or a stopped app prevents contact. Physical GrapheneOS connectivity testing is pending.

## Behavior by condition

| Condition | Implemented behavior | Limit |
| --- | --- | --- |
| No default network | Stop Bungee's own UDP peer; wait for an Android network callback, with a periodic local recheck; keep independent GPS sampling/queueing | No public connectivity probe, provider DNS or requirement for Google's validated-internet flag. Local/home-only networks remain eligible. Android may suspend or stop the service |
| Home unreachable / UDP denied / packet loss | Exponential retry ceilings of 15, 30, 60, 120, 240 and 300 seconds; 80–100% jitter; disconnect the app peer during backoff | No alternate public transport or bypass. A network change can bring the next attempt forward, with a minimum five seconds after the previous attempt; failure count is not reset by flapping |
| Authentication rejected | Show pairing/clock guidance and use a 12–15 minute cooldown; network changes cannot advance this deadline | No signature bypass, enlarged timestamp window, automatic identity deletion or provider time query. Fix the phone/home server clocks or pairing locally. Cooldown is process-local |
| Brief usable connection | Poll permitted commands and exchange recovery policy before bulk GPS; retry saved receipts; perform bounded work | Existing five-minute command deadlines remain. A command that expires offline is never made newly executable after reconnect |
| Narrow / lossy link | One GPS backlog batch per ordinary cycle, initially 25 points; shrink toward one on failure/slow cycles, increase gradually toward 100 on fast cycles | Each request retains its 10-second transport timeout. The cycle stops starting more work after a roughly 20-second budget following polling; an already-started request can finish afterward. A locate command can additionally upload one fresh fix/batch |
| Long outage | AES-GCM encrypted queue of at most 10,080 unique GPS observations; original timestamps preserved; newest eligible queued fix accompanies older catch-up points | At about one new fix/minute this is roughly seven days, not an unlimited archive or guaranteed sampling schedule. At capacity, oldest unsent points roll off; an explicit counter exposes that loss |
| Lost response / process interruption | Remove GPS only after `accepted:true`; server deduplicates GPS by observation time. Persist a command reservation/result before acting and retry its receipt separately | Delivery is not exactly-once execution. An interruption can leave an unknown outcome; the action is not repeated merely because its receipt was lost. Battery/check-in rows can repeat after an uncertain upload |
| Local pause / stop / lost permission | Independent local stop takes priority; cancel active transport requests and stop the peer without changing OS radios/routes | Pending records remain private for a later explicit resume. Turning GPS sharing off clears GPS queue/capacity count; unpairing deletes app identity/data as documented |

## Sampling, clocks and queued data

GPS collection has its own coroutine and monotonic scheduling, separate from network timeouts/backoff. It requests GPS_PROVIDER only; no network-location service is introduced. Denied permission, poor GNSS, Doze, battery controls, foreground-service rules and storage failure can still prevent collection. A valid old fix stays useful as a dated last-known point; it is never relabeled as current.

The retry scheduler and command-deadline estimates use elapsed time rather than wall-clock timers. Command polling returns home-server time inside the authenticated WireGuard channel; a conservative round-trip bound prevents a phone wall-clock adjustment from extending a command's known lifetime. This does not change either device's clock, replace authenticated request timestamps or supply secure time before the first accepted request. The phone and home server still need OS clocks within the existing two-minute request-authentication window.

Future-dated/invalid queued fixes cannot block all older valid fixes in the next upload. Future points remain queued and become eligible when home time catches up; they are not silently shifted or relabeled. Backfilled locations retain observation/receipt time separately and cannot overwrite a newer server checkpoint. The server's GPS erasure generation remains authoritative; future timestamps cannot bypass it.

Old encrypted preference queues migrate transactionally into individually AES-GCM encrypted SQLite records. A durable marker prevents reimport after migration committed but preference cleanup was interrupted. Coordinates/accuracy are encrypted; observation timestamps and counters are indexed metadata within Android's credential-encrypted app sandbox. A normal insertion/acknowledgement changes individual records rather than serializing the entire queue. The capacity-loss count is for that local queue epoch; disabling GPS or unpairing clears it. Server GPS/IP/check-in history still has no automatic expiry or capacity eviction. Only phone backlog and command receipt storage are bounded. Storage exhaustion is not repaired by deleting saved server history or phone data.

Automatic GPS restart requires precise and **background** location permission, granted explicitly in Android Settings after Bungee's explanation, plus the separate restart opt-in. Without background permission, an automatic start uses the connection-only foreground service and reports GPS needs a foreground start. Open Bungee and use **Resume GPS from this screen**. A rejected foreground-service start is handled without claiming GPS is collecting. Before the first unlock, credential-encrypted identity/data remain unavailable. No boot-before-unlock promise or hidden permission bypass is made.

## Interrupted pairing

An initial pairing still needs a usable path to the home server and a valid invitation. If the server commits redemption but its response is lost, the phone tries a normal signed policy-sync request using its existing signing key/device ID. That check can succeed only when the server already bound that exact key. Success confirms registration; it does not redeem the invitation again or permit a different key to bind. Failure preserves the local identity and invitation for a bounded retry rather than silently generating replacement keys. **Retry saved pairing** also works after an app restart; if first redemption already committed, signed confirmation does not depend on the old token still being redeemable. An expired invitation cannot enroll a new identity. Failed/completed pairing closes its own temporary tunnel unless the sharing service has already taken ownership. A service's delayed cleanup cannot close a replacement service's peer.

## Command uncertainty and delayed receipts

The phone keeps a single encrypted receipt journal, bounded to 100 records and the command-content retention horizon. It reserves the command ID before acting. If interrupted after reservation, its saved result says the outcome is unknown and will not repeat the action. If a receipt write fails before reservation, no new action executes. A full unresolved journal refuses further actions rather than evicting a live command's duplicate guard. Existing legacy per-command receipts remain readable after upgrade; the new independent outbox applies to new attempts.

Up to three saved receipts are retried per cycle, alongside receipts for newly handled commands. A transport failure leaves the outbox intact. Only a recorded receipt or an exact match to the server's existing terminal status/result settles the entry. Unknown commands, pre-poll restored state and conflicting outcomes stay unresolved; the response names the reason. The new phone ignores an old server's ambiguous `settled:true` without acceptance. Entries can still be pruned after the five-minute execution deadline plus 24 hours, or when settled and expired to make bounded room. This is not unlimited receipt retention. A force-stop, uninstall, lost key, destroyed storage or longer outage can prevent confirmation.

The server redelivers an unexpired, unconfirmed command using its original ID. Selection for a response is shown as **Offered · awaiting receipt**; the legacy API/database value `delivered` means offered, not confirmed reception. After expiry, an offered command without a receipt is shown as **Expired · unconfirmed**, because delivery or execution may have occurred. A never-offered pending command expires normally. This distinction does not assert that a response body actually reached the phone: a connection can fail immediately after polling.

A delayed, freshly signed receipt may reconcile a command retained by the server when its recorded attempt time was within the original creation/expiry interval. The command must already have been delivered; terminal outcomes cannot be overwritten. This acceptance does not extend execution authority or redeliver an expired command. Receipt arrival time is recorded separately and the dashboard labels a late confirmation. The timestamp/outcome remains a phone-reported statement, not hardware attestation. Old clients without an attempt timestamp retain the original expiry behavior. Command content/results are still purged after 24 hours from command creation, so recovery is not guaranteed beyond that horizon.

## Status and acknowledgements

- The app shows queued fixes, queue-capacity losses, last successful telemetry and approximate next retry.
- Device care shows the phone's **last reported** GPS access, queue count, oldest queued timestamp, discarded-at-capacity count and pending receipts. It cannot know a disconnected phone's current queue or permissions. An older app reports no such metrics.
- An authenticated contact updates `last_contact` independently of `last_seen` (latest accepted telemetry). A short command-only connection can establish presence while the battery reading remains older; the dashboard's battery tooltip identifies the saved telemetry age.
- A configured tunnel is not proof of delivery. Records become acknowledged only on an accepted home-server response.

Update the **server first, then the APK**. New phones report fields that older servers reject; the queue is retained if that mismatch occurs. Stable local APK signing is still required for reliable in-place updates. Physical DDIL/jamming trials and GrapheneOS background/sleep checks have not been run. See [VALIDATION.md](VALIDATION.md) for automated evidence and [SAFETY.md](SAFETY.md) for the recovery boundary.

## Command consent and invitation recovery

Pairing authorizes telemetry; household commands start off until separately approved on the phone with local unlock. Upgrade ignores the earlier implicit-consent key. The command guard is rechecked at actuation, and failed persistence vetoes commands in the current process while attempting an independent stop. No lasting stop can be promised if storage rejects every write; use Android force-stop as shown by the error. Lost-mode requests cannot override that consent.

A never-enrolled invitation may be reissued after expiry, a lost response or gateway publication failure with the same phone key/address. Tokens and PSKs rotate; paired signing identities cannot be rebound. Transactional staging/publication and resource-bounded CSV are described in [the second review](REVIEW-2026-10-SECOND.md).


## Erasure and cancellation

Home erasure rotates a random GPS generation in its write transaction. A reconnecting phone discards the full older-generation queue before adopting it, including points collected after erasure but before reconciliation. First upgrade also clears an untagged legacy queue. New sensor updates carry a local preparation stamp; a GPS/command withdrawal, local stop or generation change cancels old captures/reserved sends. Already-sent bytes can still be received by home; local withdrawal is not a remote erasure acknowledgment. Remote locate uses an exact-point acceptance response, a remaining transport budget and a server commit-admission expiry check. Read [the precise contract and tests](REVIEW-2026-10-ADVERSARIAL.md).


## Recovery photos

The authorized camera service keeps up to three encrypted, EXIF-stripped JPEGs of at most 12 KiB each. At capacity it drops the oldest and reports the loss. Photos upload separately from GPS; a photo failure has a five-minute retry delay. The server admits at most six new photos/device/hour; exact retries do not spend another slot.

System sticky recovery retains the same-boot failure streak, rate budget and queue. Optional boot recovery uses separate local approval and Android special access to restore the service from a visible startup screen after first unlock. Force-stop requires manual launch. Disarm, local stop and command withdrawal cancel pending work and clear camera consent/checkpoints/unsent photos. A connection-service failure alone preserves authorized queued photos for recovery.

Photo erasure rotates a separate generation so stale queued/in-flight uploads cannot restore erased images. The gallery shows capture and receipt times separately. See [camera setup and lifecycle limits](RECOVERY_CONTROLS.md); physical locked-camera, Doze, radio-loss and process-recovery checks are pending.
