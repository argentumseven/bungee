# Android profile companions

One physical phone stays one device in the manager. Its main installation remains the source of GPS, battery, network/IP history and phone-wide status. Sound, flashlight and location requests go to that installation.

A linked companion uses the same Bungee APK inside another Android user. It handles the actions that must occur in that user's sandbox: recovery messages, message dismissal, locally armed failed-unlock photos, and their acknowledgements/readiness. It does not collect or send GPS, battery or a second device/network history. The server rejects device telemetry and shared hardware commands from companion credentials even if a client claims those capabilities.

## Setup

1. Pair the main installation normally. In its **Device care → Android profiles**, choose **Add a profile companion**.
2. Install the same APK inside the secondary Android user. Copy the public key shown by that installation into the profile form, enter a profile name and create the invitation.
3. Scan the invitation inside that user. Pairing identifies this installation as a profile companion and links it to the existing phone automatically.
4. Start its connection and approve profile recovery messages. To enable theft photos, grant camera/notification permissions and removable device administration, then arm protection locally and wait for Ready.

The companion UI omits GPS sharing and never requests location permission. Its ordinary app-contained connection leaves Android's VPN slot free. Each installation has its own signing key, WireGuard peer and address; Android's user isolation prevents sharing the main process's in-memory transport. Never copy the main user's private keys or pairing invitation into another user. The small companion connection carries profile actions, pictures, update checks and profile readiness, rather than a second telemetry stream.

## Daily use

The manager lists companions underneath their phone in **Device care → Android profiles**. Send or clear a message on the named profile directly. Messages are queued only for that profile's credentials, and Android's notification permissions/settings govern their display. A recent foreground-user indicator describes the last report; it is not a guarantee that the user is still active. Message delivery does not automatically switch users or change Android locks.

Phone-wide **Stop all Bungee actions** also queues a stop for connected, locally approved companions, clearing their pending recovery actions and messages. Stopping one companion leaves the main installation unchanged.

The phone's normal camera gallery combines main and companion pictures and labels their source profile. Pending pictures remain in that installation's memory with the existing photo limits and erasure fences. Erasing the phone's album rotates all linked photo generations; an older queue from an offline companion cannot restore erased pictures. A single-profile album remains independently erasable through its own authenticated endpoint.

Disconnecting one companion preserves the main installation and all saved photos. Disconnecting the phone disables all its companions while retaining their archives. Reconnecting the main installation does not silently reactivate disconnected companions. Revoking and erasing the phone includes companion data; deleting its disconnected archive includes every linked profile record. Local Stop, disarm and Android app removal remain scoped to the Android user in which they are performed.

## Android limits and physical validation

Companion installation does not bypass Android user isolation. Protection begins after that user has first unlocked and armed/resumed its camera service. **End session**, reboot before first unlock, force-stop and Android camera restrictions can leave that profile unavailable. The main installation's working flashlight connection does not establish that another user's credential callbacks or camera are available.

Physical GrapheneOS validation is still required: test the named user's failed PIN callbacks, a labelled photo, upload and gallery source label; send a message into that user; switch users and verify main telemetry continues without duplicates; test End session and independent disconnection. Server integration tests and Android policy tests verify routing and scope, not physical lock-screen capture.
