# Deployment and enrollment

## Host requirements

- Linux with kernel WireGuard and Docker Compose v2. Kernel interface creation needs to work from a NET_ADMIN container. `Unknown device type` means the kernel/runtime does not expose WireGuard; granting every capability is not the solution. Load/install the host’s supported WireGuard module if available or use a suitable Linux host.
- A publicly reachable UDP endpoint (normally 51820), a hostname for the dashboard, and TCP 80/443 for Caddy certificate issuance/HTTPS. A CGNAT connection cannot receive arbitrary unsolicited UDP without an independently reachable gateway/relay.
- Encrypted persistent storage and encrypted backups. Keep the Docker daemon private. It is effectively host administration access.

The cloud machine used to create this project can build and run the server container, but cannot create kernel WireGuard interfaces and has no `/dev/net/tun`. No real VPN or physical Android device test was performed here.

## Default Compose topology

`gateway` owns the network namespace and the private `10.77.0.1` interface. `server` joins that namespace. Only UDP 51820 is published by the gateway. `web` (Caddy) connects to `gateway:8080` on the private Docker bridge and publishes HTTPS. `8081` is bound to the WireGuard address and must never be published.

Volumes:

| Volume | Access | Contains |
| --- | --- | --- |
| server-data | Rust only | SQLite, generated administrator password |
| gateway-private | Gateway only | Server WireGuard private key |
| gateway-peers | Rust + gateway | Server public key and approved /32 peer list |
| caddy-data/config | Caddy only | TLS material and state |

Back up the three application volumes together while the Rust server is stopped, or use SQLite’s online backup API for the database plus a coherent key/peer backup. Do not copy a live SQLite database without its transaction state. Restore into an isolated host, invalidate sessions, check peer revocation state, and test with a test phone. Backups retain data after logical deletion; define an expiry policy.

## Administrator credential rotation

The server reads the password file at process startup and computes an Argon2id verifier in memory. To rotate, stop the server, replace `/state/admin-password` securely with a high-entropy password of at least 16 characters (owned by UID 10001, mode 0600), then restart. All existing sessions are invalidated on restart. Alternatively mount a private secret file and configure `BUNGEE_ADMIN_PASSWORD_FILE`; never place its value in Compose YAML or source control. Keep the current secret binding when updating configuration.

## Pair and revoke

Install the Android app, copy its WireGuard public key, and create an invitation in the HTTPS dashboard. The phone scans/pastes the invitation, validates the key/route, obtains VPN consent, pairs through the tunnel, and then asks for location/notification permission. Approximate location is supported; GPS accuracy and availability depend on permissions and the device. Ordinary phone traffic is not routed through home.

Pause sharing on the phone to stop its telemetry service and disconnect its tunnel. Revoke in the dashboard to invalidate server access, erase stored telemetry and commands, and remove its peer. Unpair on the phone to erase its local identity and generate a new one. A new identity needs a new invitation. The current service does not restart itself after reboot/force-stop; start sharing again from the phone.

## Device-owner experimentation

The app has a DeviceAdminReceiver and reports whether it is device owner. Existing personal phones can opt in to force-lock through Android’s normal device-admin approval without becoming device owner.

For **a dedicated, freshly provisioned test phone** that satisfies Android’s owner-enrollment prerequisites, the standard development command is:

```sh
adb install android/app/build/outputs/apk/debug/app-debug.apk
adb shell dpm set-device-owner org.bungee.app/.BungeeAdminReceiver
```

This is an optional manual experiment, not part of setup scripts, and was not executed. Device ownership has major lifecycle/uninstall implications. Android can reject it when accounts, other users, setup state, or existing management conflict. Do not factory-reset a personal phone just to try this foundation. Full QR zero-touch/provisioning activities and enterprise policy controls remain future work.

## Proxy-aware image builds in Codex cloud

Ordinary hosts can use the README’s unmodified Compose build. This cloud’s Docker daemon needs an explicit proxy hostname mapping and the authoritative environment CA for build-time HTTPS. `scripts/docker-build-cloud.sh` derives the proxy hostname/address without reading credential values, forwards existing proxy bindings using Docker’s predefined build arguments, and supplies the system CA bundle as a BuildKit secret. It never disables TLS/package signature checks and does not install the cloud CA into runtime images.

`scripts/docker-build-cloud.sh` builds the two local development image tags. It does not deploy or expose them. Live Caddy certificate issuance and the complete Compose stack still require the host prerequisites above.
