# Validation of the history and transport update

These checks ran in this cloud instance. They establish the behavior below, not a physical GrapheneOS deployment or a fully post-quantum authenticated product.

| Check | Result |
| --- | --- |
| Rust fmt, Clippy (-D warnings), locked build | Passed |
| Database migration unit test | 1 passed; old saved fix enters history once, erased data is not re-seeded on restart |
| API and privacy runner | 41 tests reported passed, zero failures/skips; includes signed batches, range queries, pagination, backfills, deduplication, 90-day outage/restart, erasure/revocation and secret redaction |
| Browser runner | 9 tests reported passed, zero failures/skips; real enrollment/telemetry, time slices, coordinate trail, CSV contents, check-in logs, erasure, session loss, mobile overflow, no runtime errors or third-party requests |
| TypeScript / Vite build | Passed |
| Android debug APK and lint | Passed; nonfatal SDK/lint warnings remain |
| Android GPS backlog unit tests | 3 passed; persistence serialization, deduplication, bounded eviction, partial acknowledgement and retry behavior |
| Pinned Caddy TLS test | Passed against actual container: locally trusted certificate, TLS 1.3 X25519MLKEM768 negotiated, classical-only/TLS 1.2 rejected, only internal issuer configured |
| Container network policy test | Passed: isolated test-server TCP works before policy, then new outbound TCP and Docker DNS time out; inbound trusted hybrid HTTPS reaches non-root, zero-capability, read-only Rust through Caddy in the same namespace |
| Gateway configuration tests | Custom/default/invalid port validation, generated listen port, IPv4/IPv6 policy commands, and refusal to load persisted PSK-free peer configuration passed |
| Docker images | Built with package signatures and TLS verification enabled |
| Physical GrapheneOS, actual WireGuard handshake/routing, reboot/doze/MDM | **Not run**; this host cannot create a WireGuard interface and has no /dev/net/tun |
| Whole-phone zero-provider-traffic claim | **Not established**; OS GNSS assistance, system services, browser/clipboard sync and ISP metadata are outside Bungee's application boundary |
| Fully post-quantum authentication, security audit, production update signing | **Not implemented/verified**; certificate and device request signatures remain classical |

The runtime firewall test uses only isolated Docker test containers and temporary state, with no household coordinates or provider endpoint. It exercises real iptables and TLS rather than mocked network responses. It does not establish WireGuard-specific rekey, roaming, keepalive, MTU or IPv6 behavior on an actual phone; these remain mandatory field tests. The unit configuration test separately checks port and mandatory-PSK generation with controlled command stubs.

Server history has no automatic expiry. Capacity, backup restoration, concurrent long exports and storage-fault behavior still need load/fault testing. Android queue unit tests do not demonstrate Keystore hardware backing or service survival on GrapheneOS. Debug APK signing is for development; CI-generated keys can require uninstall/re-pair. The previously built unsigned optimized release is not an updated production release.

Initial cloud installation/start instructions were saved previously. This update did not publish or verify a restored cloud snapshot.
