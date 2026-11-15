# Release publication and cleanup

[`release.json`](../release.json) coordinates the app/server version and Android version code. [GitHub Releases](https://github.com/argentumseven/bungee/releases) contains APKs; a main-branch APK release is not itself a published stable container bundle.

## Normal publication

The checked main-branch workflow builds and signs once with the persistent official publisher key after Android, server/web and container checks pass. A release has `bungee.apk`, `bungee.apk.sha256` and `build.json`. Servers built from that commit use its `android-<source-prefix>` asset URL; do not casually rename those tags or delete historical assets still needed by installed servers.

The first checked APK for a version is a regular release. Later builds of that same version remain available as **prerelease build snapshots**, without replacing the latest regular download. Publication checks workflow order and numeric app versions, so an older version cannot become latest merely because a later job ran. Snapshot classification is applied by the updated publisher; old entries are not silently mass-deleted or relabelled.

A `v...` tag has a separate checked container-bundle publication path. Source installations can always use the [documented GitHub rebuild command](INSTALL.md#update-from-github) instead of waiting for a container-channel release.

## Reviewed 1.1.22 correction

The checked-in [cleanup plan](../.github/release-cleanup.json) names these exact releases:

| Action | Release |
| --- | --- |
| Keep, retitle and set latest | `android-dde1a89945a2`, ID `444812620`, app 1.1.22/code 38 |
| Proposed deletion | Intermediate `android-ed781239af27`, ID `444806816`, app 1.1.21/code 37 |
| Preserve | The earlier canonical 1.1.21 release, all other releases, both Git tags/source commits, and APK signing identities |

**The committed plan defaults to preview (`apply: false`).** It does not declare that the proposed deletion has already been approved or performed. Removing a release also removes its GitHub asset URLs; an old server built from that exact intermediate commit may need a source rebuild to prepare its new matching APK. Preserve the downloaded backup if that build is still in use.

The [maintenance workflow](../.github/workflows/release-maintenance.yml) runs a preview when the plan changes on main. It verifies release IDs, tags, exact source manifests and APK build/checksum metadata, downloads both complete APK releases, and uploads the backup artifact **before** an apply step can run. Backups are retained as workflow artifacts for 30 days; download them for longer retention. It edits the valid replacement first, then deletes only the explicitly named obsolete release object, retaining its source Git tag. Changed release content or a different latest release stops the historical plan from running.

To use GitHub's UI, open **Actions → Preview or apply release cleanup → Run workflow** on main. Leave Apply off for preview; enable it only after reviewing the plan and backup. A reviewed change setting `apply: true` also applies on the main-branch push that changes this plan.

On an operator machine with GitHub CLI authentication and repository release-write permission:

```sh
python3 scripts/cleanup-releases.py --backup-dir work/release-backup
# After reviewing the exact plan and preserving the backup:
python3 scripts/cleanup-releases.py --backup-dir work/release-backup --apply
```

Repeated apply after the named obsolete release is absent makes no changes. The script does not rewrite Git history, re-sign APKs, delete other versions, or delete container images.

## Repository About settings

The public repository previously had an empty description and an `mdm` topic even though device-owner MDM is disabled. Repository administration rights are required to edit these fields; a contents-write workflow token is not sufficient. Suggested About text:

> Self-hosted Android/GrapheneOS device finder with location history, recovery commands and local maps. No Play Services required.

Link the homepage to the README or documentation, and use relevant topics such as `android`, `grapheneos`, `self-hosted`, `privacy`, `wireguard` and `device-tracking`. Remove `mdm` so visitors are not promised enterprise device management. These are repository settings, not features enabled by a Markdown file.
