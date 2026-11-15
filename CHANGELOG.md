# Changelog

Versions come from [`release.json`](release.json). Published APK assets include `build.json` with the exact source commit, version code, SHA-256 and signing certificate. Update the server before the matching phone app.

## 1.1.22 — Android code 38

- Photo uploads can use their intended 60-second request budget; ordinary control requests retain the shorter budget.
- A transient runtime-lease conflict pauses the armed camera instead of silently withdrawing the saved local camera consent. Readiness reports explain the pause.
- Main-profile command capabilities refresh on the next sync after a profile/camera change.
- Picture buttons use server time and consistent camera readiness checks across the phone overview and profile views. Duplicate-instance notices expire consistently with their displayed lifetime.
- Shared hardware command receipts identify a background main Android user; the dashboard warns when its recent report shows that state.

## 1.1.21 — Android code 37

- Phone-level manual pictures target the recently reported active, locally approved Android profile and name it on the button.
- Missing readiness and conflicting foreground reports have explanations; Android rejects capture for an inactive profile with a clear receipt.

## 1.1.20 — Android code 36

- Manual front-camera pictures through web recovery commands, using the existing locally armed theft-photo service and upload flow.
- Sharing start/stop history on phone and web, distinguishing manual actions, Android-reported crashes, errors and uncertain exit times.
- Temporary Locate requests can work with passive GPS sharing off under existing recovery/location consent.
- GPS history remains visible through outages, with a latest-fix-based initial range, refresh/backfill and an explicit saved-history view.

## Source builds and regular releases

The first checked APK for a new app version is a regular release. Additional main-branch builds of that same version are labelled **build snapshots** and published as prereleases, so source-built servers can fetch their exact matching APK without replacing the regular download. A newer workflow number cannot promote a lower app version. Existing historical releases retain their original labels unless separately corrected.

The stable/preview **container channel** is separate from main-branch APK publication. For an updated source checkout use:

```sh
cd /usr/local/src/bungee &&
git pull --ff-only origin main &&
sudo python3 scripts/bungee-host.py rebuild &&
sudo python3 /opt/bungee/bungee-host.py status
```

See [release publication and maintenance](docs/RELEASES.md), [installation](docs/INSTALL.md), [full release history](https://github.com/argentumseven/bungee/releases), and [validation limits](docs/VALIDATION.md).
