# Validation record

This record covers automated checks and their limits. Physical GrapheneOS testing and an independent security audit are pending. The [device procedure](RECOVERY_CONTROLS.md#physical-device-checks) covers camera/boot acceptance; [SAFETY.md](SAFETY.md) covers local recovery and removal.

## Phone C2 and internal management isolation (unreleased)

Server `wg0` permits phone C2 and optional legacy DNS only. Administration uses the explicitly configured internal management address/prefixes and a Rust TLS socket bound to namespace `eth0`. The policy is documented in [the topology reference](NETWORK-TOPOLOGY.md#management-isolation).

| Check | Result |
| --- | --- |
| Rust and API | Format check, all-target clippy with warnings denied, locked build, 14 unit tests and 97 API tests pass. Regression cases reject phone-subnet binds and overlapping administrator prefixes, and deny phone sources even with a permissive in-memory ACL. |
| Firewall isolation | An isolated two-interface Docker fixture establishes a management connection on synthetic `wg0` before applying policy, verifies it is cut off, and rejects new admin connections including those addressed to the namespace's `eth0` IP. Internal management, phone C2 and configured DNS remain reachable. Disabling optional DNS blocks that service while C2 stays available. |
| Independent listener isolation | With fixture INPUT deliberately relaxed, the actual Rust image still rejects admin connections arriving on `wg0`, including an `eth0` destination. Internal HTTPS and phone C2 remain reachable. UID 10001, zero capabilities and a read-only root are retained. |
| DNS and TLS | Real scoped outbound UDP/TCP resolver checks, Docker-DNS blocking, forwarding denial, direct trusted hybrid TLS, source ACL and forged-header checks pass. Both runtime images build and the non-root server-image HTTPS check passes. |
| Host setup | 33 tests run: 31 pass; two unchanged age archive checks skip because age binaries are absent in the resumed executor. Prior real archive validation is recorded below. New cases reject wildcard/phone-overlay management publication and overlapping management CIDRs. |

The isolation fixture uses a second veth renamed `wg0` to exercise real ingress/conntrack and socket interface binding. It does not validate WireGuard cryptography or a real kernel WireGuard tunnel. Target-host tunnel, provider firewall, internal routing and reboot acceptance remain required. This update does not configure host SSH or provider rules, and does not merge/deploy the runtime PR.

## Server deployment changes after 1.1.4 (unreleased)

The host/storage contract is now 2. Android and the phone protocol are unchanged. These checks cover direct Rust TLS, explicit DNS upstreams, LUKS2 provisioning/boot configuration and age-encrypted cold archives.

| Check | Result |
| --- | --- |
| Rust | Formatting, all-target Clippy with warnings denied, locked build and 12 unit tests pass; obsolete proxy-trust unit coverage was replaced by direct-source integration checks |
| API | 97 tests pass, no failures/skips; forged forwarding headers no longer create administrator identities |
| Host/storage | 32 tests pass, including real tar/age encryption/restore, corruption/wrong-key refusal before mutation, certificate renewal retaining its CA, key/mount rejection and helper termination when an updater dies |
| TLS | Trusted direct Rust TLS 1.3 X25519MLKEM768 succeeds; classical-only, TLS 1.2, untrusted CA and unlisted/forged source tests pass |
| Web | TypeScript/Vite production build and all 18 browser tests pass |
| Containers | Both images build; built Rust image serves direct trusted hybrid HTTPS with UID 10001, zero capabilities, no-new-privileges and a read-only root. Gateway checks retain outbound deny, Docker-DNS blocking and scoped UDP/TCP resolver rules |
| Documentation | Nine embedded image assets exist, including HTML and the three drawn PNG security pictures. Security image links point to the exact commit containing the PNGs; pinned contents are checked locally and remote assets verified. The transport and backend drawings are checked against the namespace, listener, transport and peer-publication implementation; all security pictures are visually checked at document width. All 18 tracked PNG files decode. Workflow actionlint and whitespace checks pass |

This cloud host cannot perform a real LUKS mount, systemd reboot/power-loss test or kernel WireGuard deployment. Storage mount/type rejection is tested with injected observations; archive encryption/restoration uses real processes. The updater check now reports this distinction explicitly rather than claiming a full container/boot acceptance test. Complete the console reboot and migration/recovery procedure on the target host. Android/native checks were not repeated for server-only changes. No release tag or production deployment is created by these source changes.

## Version 1.1.4

This version closes the ownership/removal and pairing-stop gaps in [REMOVAL_AUDIT.md](REMOVAL_AUDIT.md). Android permission declarations, native transport code and server protocols are unchanged. The app checks device/profile ownership and failed role queries, confirms asynchronous administration removal, cancels control requests during local stop, closes pairing-only peers and expires stale camera-start approvals.

| Check | Result |
| --- | --- |
| Rust | Formatting, all-target Clippy with warnings denied, locked build and 13 unit tests pass |
| API | 99 reported tests pass, no failures/skips |
| Web | TypeScript/Vite build and 18 reported browser tests pass, no failures/skips. Thirteen dark browser screenshots regenerated |
| Android | Debug and R8-minified unsigned release build; both lint checks pass with nonfatal warnings and no errors. 76 JVM tests pass without failures/errors/skips |
| New regression coverage | Fourteen cases: owner roles/query failure, asynchronous/silent-refusal deactivation, interrupted cleanup, pairing-only peer stop, stop/re-enable during connection creation, close/publication failures and camera approval expiry/replacement/replay |
| Native | Real loopback request/peer cancellation and protocol tests rerun under Go race detection |
| Host helpers | 24 tests pass |
| APK | Version 1.1.4/code 20; debug signature continuity, 16-KiB ZIP alignment and unchanged manifest permissions/components checked |
| Containers | All three images build using a verified offline Cargo cache after the cloud proxy denied a crate download. Isolated UID-10001/read-only/zero-capability/no-new-privileges/no-network Rust smoke checks health/version, session, photo authorization and matching dashboard/assets |

Version 1.1.3 rewrote interface copy and documentation, corrected stale camera/enrollment descriptions and fixed sign-in text wrapping. Its API/browser/host/Rust checks also passed; Android had 62 JVM tests. The 1.1.4 suite retains those checks.

The debug APK is installable with its development signer. The optimized release artifact is unsigned; no production key is configured. CI debug signers can differ from the persistent local development signer.

## Android policy coverage

The 76 JVM tests exercise production policy/coordinator code, including:

- GPS backlog bounds, future-point filtering, transactional journal insert/acknowledgement/deduplication and migration failure handling. Journal tests use real host SQLite through JDBC; they do not exercise Android flash or Keystore hardware.
- Consent write/read failures, process vetoes, app-lock persistence, forbidden-policy rejection and independent cleanup after exceptions.
- Local stop/restart choices, stale opt-in invalidation, camera consent and separate boot-recovery consent.
- Retry ceilings/jitter, authentication cooldown, network-event rate floor, adaptive batches and conservative elapsed-time command deadlines.
- Persistent receipt reservations, capacity, restart and settlement without repeated actuation.
- Privacy-fence cancellation before/during sends, off/on invalidation and stale preparation rejection.
- Three-new-failure camera threshold, success/reset behavior, rolling attempt limits, local-test budget, bounded photo queue and exact acknowledgements.
- Encrypted same-boot camera checkpoint restoration, absent/corrupt/future/cross-boot rejection, preserved failure streak and attempt budget.
- Boot requests deferred until eligible, claim persistence before launch, failed-write veto, duplicate/failed-launch suppression, revocation, offer expiry/consumption and cancellation.

Manifest inspection checks the independent recovery launcher, disabled owner-provisioning activities, absent VpnService, force-lock/watch-login administration, non-exported camera service/type and optional SYSTEM_ALERT_WINDOW. The startup activity is non-exported, no-history and excluded from recents, with no lock-screen/show-screen flags or launcher filter.

These tests do not establish camera availability while locked, actual Android service restoration, notification authentication or physical recovery timing. Lint warnings include intentional synchronous preference writes and translation/KTX suggestions; a successful lint run is not a runtime test.

## Earlier network and update checks

Except for the native race tests rerun above, the following evidence is from earlier network/update runs. Those implementations are unchanged in 1.1.4.

| Area | Earlier evidence |
| --- | --- |
| Native WireGuard | Two real loopback peer/protocol tests plus three cancellation/deadline cases pass under Go race detection: wrong PSK, fixed target/header/size bounds, cancel before/during send, short deadline, single-use reservation and peer stop. ARM64/x86_64 ELF PT_LOAD alignment checked at 16 KiB |
| Runtime egress | Isolated Docker network verifies new outbound connections and Docker DNS are blocked; only an explicitly selected legacy private DNS IP/port is allowed |
| Caddy TLS | Trusted local-CA TLS 1.3 X25519MLKEM768 succeeds; classical-only exchange and TLS 1.2 are rejected |
| Administrator prefixes | Real IPv4 Docker clients: allowed source reaches the upstream route; denied source gets 403 on dashboard/API/health despite forged headers. Empty/malformed configuration prevents startup. IPv6 normalization/rules are checked; real IPv6/NAT behavior is untested |
| Proxy identity | Real Caddy overwrites the dedicated source header; Rust tests cover trusted/untrusted loopback identity and login budgets |
| Update transaction | Three services/five volumes: maintenance firewall blocks TCP, unhealthy candidate rolls back, SQLite fixture/WireGuard identity/CA survive, trial-only file disappears and a healthy candidate commits. A fixture replaces kernel WireGuard interface creation; real firewall, admission, snapshot and restore code runs |
| Installer/systemd | Generated Compose and systemd unit syntax checked. Production installer/timers were not enabled here; kernel preflight fails with “Unknown device type” |
| CI publication | Actions lint and Compose schema checked. Publication is configured to wait for tests and exact-image checks. Hosted execution, package visibility, stable-channel promotion and ARM64 runtime remain unverified here |

The updater verifies registry TLS, fixed repositories, immutable digests and release compatibility. Client-side publisher-signature enforcement is absent. Snapshot archives are root-only plaintext tar files with checksums and require encrypted storage; exported copies need separate encryption.

## API, storage and review regressions

| Area | Evidence |
| --- | --- |
| Enrollment | Expiry/housekeeping, same-key reissue with token/PSK rotation, old-token/paired-key rejection, 253-address pool reclamation, SQL/audit failures and peer-file staging/publication failures |
| Availability | 4,096 fabricated device IDs do not exhaust another peer's signed access or administrator budgets; full-map expiry/counter cases tested |
| Commands | Offered/confirmed/expired-unconfirmed states, saved reservations, immutable terminal results, unknown/conflicting receipts and late reconciliation. A snapshot restored before polling leaves receipts unresolved until valid delivery state exists |
| Locate | Unoffered, null-fix and expired uploads rejected. Exact stored-point acknowledgement required. An SQL trigger forces expiry during insertion to check final commit-admission rollback |
| GPS erasure | Future-skewed fix, signed slow body completed after erase, concurrent upload/erase, repeated erase, restart and generation reconciliation. Authentication before erase cannot authorize an old-generation write afterward |
| Photos | Device-bound authenticated reads; format/metadata/EXIF/dimension/body bounds; exact-ID retries; conflicting content; hourly quota; pagination; delayed/concurrent erased-generation uploads; restart and revocation |
| Geography | Local raster TMS-to-XYZ tiles require authentication/no-store. Missing coverage never redirects. Artificial MMDB supports test city/radius; private/unknown addresses retain IP without invented coordinates. Unknown peers, stale snapshots and forwarding headers cannot supply IP evidence |
| Dataset imports | Restricted local validator, read-only generation mounts, rejection before downtime and failed-trial rollback |
| CSV | A 500,000-row synthetic export stayed below the test's 64-MiB additional-memory ceiling. Two stalled exports enforce admission; cancellation releases a slot; logout and erasure interrupt snapshots. Interval/daily JSON and CSV agree |
| History readers | Two recurring scans over 500,000 rows permit a telemetry write within the two-second regression ceiling (about 30 ms in the measured run). Range/bucket limits enforced; revoked routes return 404 |
| Persistent controls | Server/client reject persistent fields even with claimed owner consent; old policies project to permitted recovery fields; reboot commands and queued legacy reboots are rejected |

These fixture/load results apply to their test inputs and host. They do not establish all network/disk/browser capacity, phone battery use, production dataset accuracy or complete roaming history. DNS tests explicitly seed an old-policy fixture; new managed-DNS enrollment remains disabled.

The first 1.1.2 API run exposed a test-clock race: a precomputed future timestamp at now+121 could fall within the unchanged 120-second allowance before handling. A signed diagnostic reproduced it after a 1.25-second delay. The invalid fixture now uses now+300 and the full suite passes; server validation was unchanged.

Historical findings and detailed fixes are retained in [the first review](REVIEW-2026-10.md), [second review](REVIEW-2026-10-SECOND.md) and [adversarial review](REVIEW-2026-10-ADVERSARIAL.md).

## Uncompleted device and deployment checks

A dedicated AOSP Android 16 software emulator installed an intermediate APK and listed an app task. System-service failures and UI/command timeouts prevented interactive recovery assertions. The emulator was stopped. The final APK has not passed interactive runtime checks.

Physical GrapheneOS work includes locked/background camera capture, real credential callbacks, privacy controls, Doze/battery endurance, reboot/first unlock, same-signer updates, automatic startup with both grants, permission revocation, denied launch, another VPN, offline recovery, storage corruption/faults and ordinary administration deactivation/uninstall. Test Settings, unlocking, calls, keyboard and launcher access throughout.

The development host cannot create a kernel WireGuard interface or complete a real deployment. Full systemd boot/power-loss recovery, ARM64 execution, physical roaming and home routing remain unverified. Old device-owner removal is neither guaranteed nor phone-tested; new owner creation/operation is disabled.

No real household data or physical device is used in automated fixtures. No stable release tag or automatic-update promotion is created by this source change.

## Verification interruptions in 1.1.4

The first full API run stalled in the CSV erasure check: it registered its close listener after awaiting erasure, so an already-closed paused stream could leave the test waiting forever. Cancellation listeners now register before logout/erase, preserve the incomplete-stream assertions and have a five-second failure timeout. The focused export checks and complete suite were rerun.

The normal container build received HTTP 403 for a locked crate from the development proxy. A temporary build stage was seeded with 204 cached crate archives verified against Cargo.lock SHA-256 checksums and compiled offline. TLS/checksum checks and dependencies were unchanged; the repository Dockerfile was not modified. The runtime container smoke uses that resulting binary and current dashboard.

## 1.1.5 recovery and tracking changes

Fixed the photo uploader passing its 20-second worker deadline into a native HTTP transport limited to 10 seconds, which could reject every photo request before transmission. Added regression coverage for request-budget clamping, photo-ID tombstones and all-device erasure, RAM-only photo queue acknowledgement/session changes, current-streak reporting, short-window GPS estimation with a conservative uncertainty floor, moving/date-line fixes, collection-source filters before pagination/recurrence and matching CSV, individual queued/offered-command cancellation and late receipts, and authenticated PMTiles byte ranges. Real bundled DB-IP Lite records are decoded for IPv4 and IPv6 in the API test; artificial raster/vector fixtures remain explicitly synthetic. Native WireGuard tests carry the new command preflight path through the fixed-home allowlist.

The PMTiles CLI release binary checksum was verified and its regional dry-run/verification tested against a local artificial archive. Full US extraction requires access to Protomaps catalogue/build hosts; this development environment blocks those hosts. The host command checks estimates, file-size limits and free encrypted capacity before import, and preserves a running map if acquisition fails. Actual US archive size/coverage must be verified by the host acquisition run. Physical Android/GrapheneOS camera callbacks, locked capture, alarm volume/flash behavior and signal availability still require on-device acceptance; unit/build/browser tests do not establish those hardware results.

Final checks for this source: 17 Rust unit tests, 106 API tests, six GPS presentation tests, 21 browser tests (including local vector rendering), and 60 host tests (58 pass, two age-binary-dependent checks skipped in this executor). Native transport race tests and direct hybrid-TLS checks pass. Android unit/lint/APK build results are recorded by the release workflow; physical-device limits above still apply.

1.1.6 preserves readable legacy queued photos by adopting them into RAM before removing the old encrypted preference. Migration retries deduplicate photo IDs, and invalid legacy data cannot partially replace the current RAM queue. Android build/lint and 94 unit tests cover the corrected upgrade.
