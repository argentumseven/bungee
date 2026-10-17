# Security diagram exports

The two Mermaid blocks in [SECURITY.md](../SECURITY.md) are the diagram sources. GitHub renders them inline, so the Security document has no image request tied to `main`, a pull-request branch, or private raw-file authentication.

- `security-architecture.png` / `.svg`: direct Rust HTTPS, WireGuard device HTTP, separate optional DNS, network and host storage boundaries.
- `storage-lifecycle.png` / `.svg`: host-only keys, encrypted data, local certificate issuance and authenticated cold backups.

Regenerate all exports from those blocks and validate their syntax in Chromium:

```sh
PUPPETEER_SKIP_DOWNLOAD=true npm install --prefix work/diagram-tools --no-save --no-audit --no-fund @mermaid-js/mermaid-cli@11.12.0
CHROME_BIN=/usr/bin/chromium node scripts/render-security-diagrams.mjs
```

Run from the repository root after `npm ci`. The renderer uses the existing Playwright dependency, an installed Chromium and Mermaid's local browser bundle; it requests no remote fonts, icons or diagram service. `MERMAID_BUNDLE` may point to another locally installed Mermaid browser bundle. Intermediate dependencies stay under ignored `work/`.

The repository Security tab displays the default branch. A correction on a PR branch appears there after the PR is merged; use that branch's `docs/SECURITY.md` to preview it before merging.
