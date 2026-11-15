# Draft for r/selfhosted

Review the current subreddit rules and replace any personal wording before posting. This is a draft; nothing has been posted.

**Title:** Bungee: a self-hosted Android device finder and location history, without Play Services

I've been building Bungee for Android/GrapheneOS phones that report to a server you run. It has a web dashboard for dated last-known GPS, retained history/CSV, alarms, recovery messages and optional locally approved theft photos. It doesn't need a Google account, FCM or a public tile API.

The Android app has an app-contained WireGuard stack that carries only its own traffic and leaves Android's VPN slot available. Your server stores the records; maps are served locally. The runtime containers deny new application egress. Host software/APK/map downloads are separate trusted maintenance tasks, not covered by that egress restriction.

Setup currently targets a Linux host/VM with systemd, Docker/Compose and kernel WireGuard. It provisions LUKS2 storage and encrypted rollback snapshots. Away-from-home phones need a reachable numeric IP and one forwarded UDP port; the dashboard stays on a LAN/private management network with HTTPS. CGNAT relay/discovery and automatic dynamic-IP handling aren't built in.

It's AGPL-3.0, with code, setup instructions, synthetic-data screenshots and the security model here:

https://github.com/argentumseven/bungee

This is an early small project, not independently audited. The server administrator can read stored data, and Android permissions/background restrictions still matter. There's no powered-off/crowdsourced finding or remote wipe. I'd appreciate feedback on home-server setup, GrapheneOS behavior and the security design—especially anything that is unclear or unnecessarily difficult to operate.
