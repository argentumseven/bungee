# Validation of recovery, managed DNS and recurrence

These checks ran in the cloud workspace. They establish the behavior below; physical GrapheneOS routing, provisioning and recovery remain unverified.

| Check | Result |
| --- | --- |
| Rust fmt, Clippy (`-D warnings`), locked build | Passed |
| Rust unit tests | 5 passed: migration/checkpoint preservation, DNS grouping/upstream bounds, core-package protection, recurrence pagination/DST |
| API/privacy/managed-DNS runner | 55 reported tests passed, zero failures/skips: signed enrollment/history/backfill/restart/erasure/revocation; recurrence query bounds; reboot capability, reauthentication and uncertain receipts; policy consent/revisions; UDP/TCP DNS, truncation/invalid IDs, summaries/isolation, restart, consent withdrawal and in-flight revocation |
| Native app-contained WireGuard | 2 Go tests passed: actual encrypted peer-to-peer WireGuard over loopback with userspace IP/TCP, fixed HTTP request/response; wrong PSK cannot reach API; provider hostnames/default ports/foreign routes/paths/headers/oversized requests rejected; stop closes transport |
| Browser / TypeScript / Vite | Build and 10 reported browser tests passed, zero failures/skips: actual signed fixture enrollment, policy save and validation, DNS summary view, reboot confirmation, recurring/daily time lookups, trail, CSV, erasure, session loss, mobile overflow and zero third-party requests/runtime errors |
| Screenshots | Refreshed sign-in, populated dashboard, mobile dashboard, history, interval and daily history, device care, owner controls, mobile care and reboot confirmation; isolated synthetic coordinates/DNS only |
| Android debug APK / lint / tests | Built; lint passes with nonfatal warnings. Six JUnit tests pass for encrypted-queue serialization/bounds/acknowledgement and policy defaults/package/consent bounds. ARM64 + x86_64 only |
| Operator signing helper | Passed optimized release build/lint and `apksigner` verification using a disposable local **test** key. No production key generated/distributed; persistent owners must supply their own stable signing identity |
| APK verification | Debug signature and ZIP alignment including 16-KiB native-page alignment checked; this does not demonstrate runtime behavior on a device |
| Caddy TLS | Actual pinned container: trusted local CA, TLS 1.3 X25519MLKEM768 succeeds; classical-only/TLS1.2 rejected; no public issuer |
| Container network policy | Actual isolated Docker network: baseline private TCP succeeds, default new egress and Docker DNS blocked; only the configured private upstream IP/port becomes reachable; other ports/Docker DNS stay blocked; UDP/TCP DNS redirects installed; trusted hybrid HTTPS reaches non-root/zero-capability/read-only Rust through Caddy |
| Gateway configuration / Compose / CI | Chosen/default/invalid port and private-upstream validation; persisted PSK-free peers refused; DNS rules checked; Compose schema and Actions workflow lint pass |
| Docker images / reusable setup | Both images built with TLS/package verification; repeated setup script installs/activates pinned Go + NDK, builds native AAR/server/web/APK; dev server returns healthy JSON and dashboard HTML |
| Physical GrapheneOS, other-VPN coexistence, actual home gateway routing | **Not run**; no physical device, kernel WireGuard interface or host TUN available. Native protocol test does not prove Android routing, handoff, MTU, IPv6 or OS background behavior |
| Device-owner lifecycle / DNS policy / app suspension / reboot / first unlock | **Not physically tested**. API/compiled app/fixtures exercise contracts, not OS enforcement. Android can refuse policies or reboot, and errors/completion uncertainty are exposed |
| Whole-phone zero-provider traffic / fully quantum-proof product | **Not established**. OS services, GNSS assistance, other VPNs/apps, browser/clipboard sync, home DNS upstream behavior and ISP metadata remain separate. Certificate/device/APK signatures are classical |

No household coordinates, real phone or provider DNS endpoint is used by the tests. Browser DNS rollups are explicit synthetic fixtures; the separate managed-DNS suite forwards actual packets to an owned loopback UDP/TCP fixture. The network test uses actual iptables/containers, not mocked firewall results. Go tests install no host VPN and require no kernel TUN.

Server GPS/check-in/DNS history has no automatic expiry. Load, disk exhaustion, backup restore, long exports/concurrent backfills and fault handling need further testing. SQL erasure is logical; blocks/backups require encrypted storage and an expiry policy. App-queue tests do not verify hardware-backed Keystore or service survival. No claim of security audit, production readiness or hardware attestation is made.

CI debug keys can change across releases and are unsuitable for persistent device owners. The optimized signing check used a disposable test key solely to validate the helper; it is not a production release. See [management](MANAGEMENT.md) for stable operator signing and decommissioning.

Cloud install/start instructions were saved as a configuration draft. Saving is separate from reviewing, saving and publishing the environment in settings; restoration in a new task was not verified.
