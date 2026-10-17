# Security pictures

These are drawn raster PNG pictures, with fixed spacing and large labels. There are no Mermaid blocks or automatic layout scripts.

- `security-architecture.png` shows direct Rust HTTPS, the separate WireGuard device API, optional DNS and other phone traffic.
- `storage-lifecycle.png` shows encrypted live data and cold encrypted backups with separate host keys.

The pictures describe the deployment changes in [PR #1](https://github.com/argentumseven/bungee/pull/1). They are published on the default branch so the repository Security tab can display them before the implementation is merged. The Security document labels this deployment status explicitly.

Security-tab image URLs include the full repository path and an immutable commit containing the PNG, rather than relying on relative paths resolved from the Security tab. Run `python3 scripts/check-doc-images.py` to check embedded assets and pinned content.
