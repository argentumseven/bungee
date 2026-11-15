# Contributing

Bug reports, setup feedback and focused fixes are welcome. Start with the [README](README.md), [security boundaries](docs/SECURITY.md), and [writing guide](docs/WRITING.md). Use synthetic locations, photos, keys and invitations in public reports and screenshots.

## Report a problem

Include the server/app version and source commit if available, Android/GrapheneOS build, deployment type and exact steps. Say what you expected and what actually happened. For a failed recovery command, include its result text and the relevant profile's readiness status. Redact tokens, pairing bundles, private keys, passwords, locations and photographs. Use [security reporting](SECURITY.md) for vulnerabilities.

## Local development and checks

The project has a Rust server, React/TypeScript dashboard, Kotlin Android app and a Go userspace transport. See [platform details](docs/PLATFORM.md). Use the versions pinned by `rust-toolchain.toml`, the lockfiles and CI. Browser/TLS tests use Node 24 and a current Chromium; TLS fixtures require OpenSSL support for X25519MLKEM768.

```sh
npm ci
npm ci --prefix web
npm run build --prefix web
cargo build --locked --manifest-path server/Cargo.toml
cargo test --locked --manifest-path server/Cargo.toml
cargo fmt --manifest-path server/Cargo.toml -- --check
cargo clippy --locked --all-targets --manifest-path server/Cargo.toml -- -D warnings
npm test
```

Build the server and web assets before the API/browser fixtures. Do not replace the server executable while a fixture is running. API fixtures use temporary state and signed simulated phones; they do not need or prove a physical phone/WireGuard deployment.

```sh
npx playwright-core install chromium firefox
npm run test:browser
npm run test:tls
python3 -m unittest discover -s tests -p 'test_*.py' -v
python3 scripts/check-doc-images.py
```

Set `CHROME_BIN`/`FIREFOX_BIN` to your installed test browsers as needed. Browser tests regenerate documentation screenshots; keep the intended image changes with UI changes. [Screenshot provenance](docs/SCREENSHOTS.md) identifies their fixtures. Docker namespace/firewall checks additionally require Docker and the host's kernel/network capabilities; the [CI workflow](.github/workflows/check.yml) lists those checks and the native/Android build steps. Android needs the SDK/NDK, a compatible JDK and the rebuilt transport AAR (`bash scripts/build-transport.sh`), then Gradle assembly, unit tests and lint.

Keep changes focused, explain the behavior and validation in the pull request, and preserve local stop/removal, consent, fixed transport destinations and source restrictions. Describe any untested physical-device behavior honestly. A passed build is not an independent security audit.

App releases coordinate `release.json`, Cargo and web package metadata. Android behavior changes need a new version code and matching app version. Documentation-only/source builds can retain the existing app version; the publisher labels additional APKs as build snapshots.
