# Denied, disrupted, intermittent and limited connectivity

Alpha.8 adds DDIL handling to the existing visible, removable personal app. It does not add airplane-mode automation, root, persistent network controls, another VPN, a relay or a public service. It cannot deliver packets through a radio blackout, blocked WireGuard UDP, a powered-off phone or a stopped app. Physical GrapheneOS behavior remains unverified.

## Behavior by condition

| Condition | Implemented behavior | Limit |
| --- | --- | --- |
| No default network | Stop Bungee's own UDP peer; wait for an Android network callback, with a periodic local recheck; keep independent GPS sampling/queueing | No public connectivity probe, provider DNS or requirement for Google's validated-internet flag. Local/home-only networks remain eligible. Android may suspend or stop the service |
| Home unreachable / UDP denied / packet loss | Exponential retry ceilings of 15, 30, 60, 120, 240 and 300 seconds; 80–100% jitter; disconnect the app peer during backoff | No alternate public transport or bypass. A network change can bring the next attempt forward, with a minimum five seconds after the previous attempt; failure count is not reset by flapping |
| Authentication rejected | Show pairing/clock guidance and use a 12–15 minute cooldown | No signature bypass, enlarged timestamp window, automatic identity deletion or provider time query. Fix the phone/home server clocks or pairing locally |
| Brief usable connection | Poll permitted commands and exchange recovery policy before bulk GPS; retry saved receipts; perform bounded work | Existing five-minute command deadlines remain. A command that expires offline is never made newly executable after reconnect |
| Narrow / lossy link | One GPS backlog batch per ordinary cycle, initially 25 points; shrink toward one on failure/slow cycles, increase gradually toward 100 on fast cycles | Each request retains its 10-second transport timeout. The cycle stops starting more work after a roughly 20-second budget following polling; an already-started request can finish afterward. A locate command can additionally upload one fresh fix/batch |
| Long outage | AES-GCM encrypted queue of at most 10,080 unique GPS observations; original timestamps preserved; newest eligible queued fix accompanies older catch-up points | At about one new fix/minute this is roughly seven days, not an unlimited archive or guaranteed sampling schedule. At capacity, oldest unsent points roll off; an explicit counter exposes that loss |
| Lost response / process interruption | Remove GPS only after `accepted:true`; server deduplicates GPS by observation time. Persist a command reservation/result before acting and retry its receipt separately | Delivery is not exactly-once execution. An interruption can leave an unknown outcome; the action is not repeated merely because its receipt was lost. Battery/check-in rows can repeat after an uncertain upload |
| Local pause / stop / lost permission | Independent local stop takes priority; cancel active transport requests and stop the peer without changing OS radios/routes | Pending records remain private for a later explicit resume. Turning GPS sharing off clears GPS queue/capacity count; unpairing deletes app identity/data as documented |

## Sampling, clocks and queued data

GPS collection has its own coroutine and monotonic scheduling, separate from network timeouts/backoff. It requests GPS_PROVIDER only; no network-location service is introduced. Denied permission, poor GNSS, Doze, battery controls, foreground-service rules and storage failure can still prevent collection. A valid old fix stays useful as a dated last-known point; it is never relabeled as current.

The retry scheduler and command-deadline estimates use elapsed time rather than wall-clock timers. Command polling returns home-server time inside the authenticated WireGuard channel; a conservative round-trip bound prevents a phone wall-clock adjustment from extending a command's known lifetime. This does not change either device's clock, replace authenticated request timestamps or supply secure time before the first accepted request. The phone and home server still need OS clocks within the existing two-minute request-authentication window.

Future-dated/invalid queued fixes cannot block all older valid fixes in the next upload. Future points remain queued and become eligible when home time catches up; they are not silently shifted or relabeled. Backfilled locations retain observation/receipt time separately and cannot overwrite a newer server checkpoint. The server's deliberate-erasure cutoff remains authoritative.

The existing encrypted GPS queue migrates to a single encrypted queue/counter record on the phone. The capacity-loss count is for that local queue epoch; disabling GPS or unpairing clears it. Server GPS/IP/check-in history still has no automatic expiry or capacity eviction. Only phone backlog and command receipt storage are bounded. Storage exhaustion is not repaired by deleting saved server history or phone data.

## Interrupted pairing

An initial pairing still needs a usable path to the home server and a valid invitation. If the server commits redemption but its response is lost, the phone tries a normal signed policy-sync request using its existing signing key/device ID. That check can succeed only when the server already bound that exact key. Success confirms registration; it does not redeem the invitation again or permit a different key to bind. Failure preserves the local identity and invitation for a bounded retry rather than silently generating replacement keys. **Retry saved pairing** also works after an app restart; if first redemption already committed, signed confirmation does not depend on the old token still being redeemable. An expired invitation cannot enroll a new identity. Failed/completed pairing closes its own temporary tunnel unless the sharing service has already taken ownership. A service's delayed cleanup cannot close a replacement service's peer.

## Command uncertainty and delayed receipts

The phone keeps a single encrypted receipt journal, bounded to 100 records and the command-content retention horizon. It reserves the command ID before acting. If interrupted after reservation, its saved result says the outcome is unknown and will not repeat the action. If a receipt write fails before reservation, no new action executes. A full unresolved journal refuses further actions rather than evicting a live command's duplicate guard. Existing legacy per-command receipts remain readable after upgrade; the new independent outbox applies to new attempts.

Up to three saved receipts are retried per cycle, alongside receipts for newly handled commands. A transport failure leaves the outbox intact. An authenticated definitive server response settles the entry. Entries can be pruned after the five-minute execution deadline plus 24 hours, or when settled and expired to make bounded room. This is not unlimited receipt retention. A force-stop, uninstall, lost key, destroyed storage or longer outage can prevent confirmation.

The server redelivers an unexpired, unconfirmed command using its original ID. After expiry, a delivered command without a receipt is shown as **Expired · unconfirmed**, because delivery or execution may have occurred. A never-delivered pending command expires normally. This distinction does not assert that a response body actually reached the phone: a connection can fail immediately after polling.

A delayed, freshly signed receipt may reconcile a command retained by the server when its recorded attempt time was within the original creation/expiry interval. The command must already have been delivered; terminal outcomes cannot be overwritten. This acceptance does not extend execution authority or redeliver an expired command. Receipt arrival time is recorded separately and the dashboard labels a late confirmation. The timestamp/outcome remains a phone-reported statement, not hardware attestation. Old clients without an attempt timestamp retain the original expiry behavior. Command content/results are still purged after 24 hours from command creation, so recovery is not guaranteed beyond that horizon.

## Honest status

- The app shows queued fixes, queue-capacity losses, last successful telemetry and approximate next retry.
- Device care shows the phone's **last reported** queue count, oldest queued timestamp, discarded-at-capacity count and pending receipts. It cannot know a disconnected phone's current queue. An older app reports no such metrics.
- An authenticated contact updates `last_contact` independently of `last_seen` (latest accepted telemetry). A short command-only connection can establish presence while the battery reading remains older; the dashboard's battery tooltip identifies the saved telemetry age.
- A configured tunnel is not proof of delivery. Records become acknowledged only on an accepted home-server response.

Update the **server first, then the APK** to alpha.8. New phones report fields that older servers reject; the queue is retained if that mismatch occurs. Stable local APK signing is still required for reliable in-place updates. No production deployment, physical DDIL/jamming trial or real GrapheneOS background/sleep validation is claimed. See [VALIDATION.md](VALIDATION.md) for automated evidence and [SAFETY.md](SAFETY.md) for the recovery boundary.
