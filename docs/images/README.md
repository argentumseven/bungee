# Security pictures

`security-architecture.png` and `storage-lifecycle.png` are the actual drawn pictures used by [SECURITY.md](../SECURITY.md). They are raster PNGs with large type, spacious boxes and fixed arrow placement. There are no Mermaid blocks or automatic layout scripts.

- The network picture separates direct administrator HTTPS, the WireGuard device API, optional DNS and other phone traffic. TLS ends in Rust.
- The storage picture separates the LUKS unlock key from the age backup identity and shows the cold-backup/verified-restore sequence.

The document links to the exact commit that contains these pictures. That keeps its image targets valid in a private repository and before a PR is merged, without assuming the pictures already exist on `main`. When replacing a picture, commit the PNG first, then update the image link to that commit. The image checker verifies pinned content when that commit is present locally.

The GitHub Security tab displays the default branch. It picks up these document changes when the PR is merged. The PR's `docs/SECURITY.md` provides the current preview.
