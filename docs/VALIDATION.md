# Initial implementation validation

These checks ran in the current cloud instance. They do not establish physical GrapheneOS behavior or successful restoration into a new task.

| Check | Result |
| --- | --- |
| Rust build with Cargo.lock | Passed |
| Rust formatting and Clippy with warnings treated as errors | Passed |
| TypeScript and dashboard production build | Passed |
| Database migration unit test | Passed; original saved location preserved during upgrade, repeated startup does not restore erased data |
| Live API integration runner | 35 tests reported passed; no failures/skips; includes a 90-day offline phone, server restart/cleanup, missing/older GPS fixes, and authenticated erasure |
| Chromium browser runner | 8 tests reported passed; desktop/mobile, real enrollment UI, saved-location erasure, session loss/logout, no runtime errors or third-party requests |
| Android debug APK | Built; development signature verified with apksigner |
| Android release APK | Optimized unsigned release built; signing/distribution not configured |
| Android lintDebug | 0 errors, 23 nonfatal warnings (preference API/style suggestions and context/listener analysis); no blanket lint baseline or ignored errors |
| Debug APK ZIP alignment | 16-KiB ZIP alignment check passed; native runtime behavior remains untested |
| Both Docker images | Built with package signatures/TLS verification enabled |
| Rust container | Runs as UID 10001 with no capabilities and read-only root; health, sign-in and authenticated device-list requests pass |
| Compose configuration | Parses successfully with explicit test host variables |
| Setup script | Completed and completed again with retained dependencies/artifacts |
| Development start script | Starts current dashboard/API; root HTML and health responses verified; generated password/state permissions 0600/0700 |
| Real WireGuard gateway | **Blocked in this host**: interface creation returns `Unknown device type`; no `/dev/net/tun` exists. The gateway test container was removed |
| Real phone, VPN traffic routing, doze/reboot, camera, device owner | **Not run**; a suitable Linux host and consenting test GrapheneOS device are required |
| Caddy public TLS/DNS and full Compose deployment | **Not run**; requires a real hostname/reachable host and functioning gateway |
| Cloud draft | Installation and startup instructions saved, with research-domain additions; no publication or fresh-task restoration verified |

API checks exercise real Rust processes and temporary databases: authentication/CSRF, key binding and proof, one-use and expired enrollment, tampering, stale signatures, wrong keys, replay, coordinates, capability denial/withdrawal, command queue/delivery/receipts, expiration, revocation, and audit redaction. Recovery checks simulate 90 days offline, restart the server with its saved database, and verify the original observation timestamp survives. They verify that missing/older fixes preserve location while new battery state is accepted, that authenticated erasure keeps pairing, that cached erased fixes cannot reappear, and that a newer observation can be saved. Browser checks use real endpoints rather than mocked responses. Test phones/locations belong only to temporary fixtures.

The SDK tools report an XML-schema-version warning because the pinned Android Gradle tooling and current repository metadata have different schema revisions. Required packages install and the Android builds/lint complete. Native symbol stripping is unavailable for some prebuilt library binaries, which are packaged as supplied by their verified dependency artifacts.

Signed debug APK prereleases are published by CI after checks pass. No production release, production deployment, or physical-device enrollment was performed. The optimized unsigned release build was validated for the initial foundation; the retention update targets the signed debug APK.
