# Screenshots

These captures come from the running Bungee web manager built from the current **1.1.22** source and this documentation/update-help revision. The browser fixtures use fictional household names, signed simulated phones, synthetic locations/maps/GeoIP, disposable invitations and a synthetic camera-test image. They contain no real household records. Map fixtures demonstrate rendering and local delivery, not real geography or the production map catalogue.

Mobile captures show the **web manager at a 390-pixel viewport**, not the Android app. Notification previews are in-app illustrations. These screenshots do not establish physical Android camera, background-service or profile-switch behavior.

## Reproduce the captures

Build the current server and web assets first, then run:

```sh
npm run build --prefix web
cargo build --locked --manifest-path server/Cargo.toml
npm run test:browser
python3 scripts/check-doc-images.py
```

Use Node 24 and installed Chromium/Firefox (or set `CHROME_BIN`/`FIREFOX_BIN`). Each fixture starts temporary local servers, creates its own test state and cleans it up. Tests save PNGs directly from the browser; the committed screenshots are not composited UI mockups. `tests/browser.mjs`, `profile-companions-browser.mjs`, `vector-browser.mjs`, `manual-photos-browser.mjs`, `sharing-history-browser.mjs` and `device-records-browser.mjs` own the captures. Some static illustrations can produce identical PNG bytes when recaptured.

## Overview and recovery

### Phone overview

Desktop viewport of the main phone view.

![Phone overview in the Bungee web manager](screenshots/overview.png)

### Complete recovery dashboard

Full-page overview with dated status, saved position and recovery controls.

![Complete recovery dashboard in the Bungee web manager](screenshots/dashboard.png)

### Manual picture

The phone-level command names its locally approved camera profile.

![Manual picture in the Bungee web manager](screenshots/manual-picture.png)

### Device care

Camera readiness, recovery settings and sharing state.

![Device care in the Bungee web manager](screenshots/device-care.png)

### Recovery photos

A clearly labelled synthetic camera-test image; no household photo is published.

![Recovery photos in the Bungee web manager](screenshots/recovery-photos.png)

### Recovery message preview

The web form and illustrative Android notification preview.

![Recovery message preview in the Bungee web manager](screenshots/message-preview.png)

### Illustrative notification

An illustration inside the web application, not a physical-device screenshot.

![Illustrative notification in the Bungee web manager](screenshots/notification-preview.png)

## History and maps

### Street-map tracking

Synthetic vector streets and locations served from the local test archive.

![Street-map tracking in the Bungee web manager](screenshots/regional-street-tracking.png)

### GPS history

Saved points, selection and original observation times.

![GPS history in the Bungee web manager](screenshots/history.png)

### Interval lookup

A recurring interval search over stored GPS records.

![Interval lookup in the Bungee web manager](screenshots/history-interval.png)

### Daily lookup

A daily-at-time search; the archive is kept independently of the query.

![Daily lookup in the Bungee web manager](screenshots/history-daily.png)

### Approximate IP history

Test GeoIP data, separate from GPS and labelled approximate.

![Approximate IP history in the Bungee web manager](screenshots/history-ip.png)

### Sharing start/stop history

Manual, crash, error and unknown-exit events remain distinct.

![Sharing start/stop history in the Bungee web manager](screenshots/sharing-history.png)

### Maps and storage

The host-download status UI with synthetic map catalogue/capacity data.

![Maps and storage in the Bungee web manager](screenshots/maps-storage.png)

## Pairing and Android profiles

### Sign in

Administrator login; there is no built-in default password.

![Sign in in the Bungee web manager](screenshots/sign-in.png)

### Pairing and history

Disconnect, reconnect, erasure and inactive pairing cleanup are separate actions.

![Pairing and history in the Bungee web manager](screenshots/pairing-history.png)

### One phone

Ordinary main-installation view before adding companions.

![One phone in the Bungee web manager](screenshots/profile-workflow-normal-phone.png)

### Choose a main Android profile

Pairing dialog; names, public key and all invitations in these fixtures are disposable test data.

![Choose a main Android profile in the Bungee web manager](screenshots/profile-workflow-choose-main.png)

### Pending companion

A disposable companion invitation waiting for enrollment.

![Pending companion in the Bungee web manager](screenshots/profile-workflow-pending-invitation.png)

### Paired profile overview

One physical phone with separately paired Android installations.

![Paired profile overview in the Bungee web manager](screenshots/profile-workflow-phone-overview.png)

### Companion actions

Profile-local camera and message controls.

![Companion actions in the Bungee web manager](screenshots/profile-workflow-sandbox-actions.png)

### Profile connected

A companion connection does not imply fresh main-device telemetry.

![Profile connected in the Bungee web manager](screenshots/profile-workflow-limited-connection.png)

### Duplicate-instance report

The manager explains a conflicting runtime identity.

![Duplicate-instance report in the Bungee web manager](screenshots/profile-workflow-duplicate-blocked.png)

## Server updates

### Update this server

The exact source-update command, copy control and explanation of source versus container-channel updates.

![Update this server in the Bungee web manager](screenshots/server-updates.png)

## Mobile web layouts

### Mobile dashboard

Recovery controls in a 390-pixel viewport.

<img src="screenshots/mobile-dashboard.png" width="330" alt="Mobile dashboard in the Bungee web manager">

### Mobile device care

Status and settings reflow on the web manager.

<img src="screenshots/mobile-device-care.png" width="330" alt="Mobile device care in the Bungee web manager">

### Mobile manual picture

The camera target stays visible on the action.

<img src="screenshots/mobile-manual-picture.png" width="330" alt="Mobile manual picture in the Bungee web manager">

### Mobile photo gallery

Synthetic test photo and capture/receipt details.

<img src="screenshots/mobile-recovery-photos.png" width="330" alt="Mobile photo gallery in the Bungee web manager">

### Mobile maps and storage

Map selection and capacity details.

<img src="screenshots/mobile-maps-storage.png" width="330" alt="Mobile maps and storage in the Bungee web manager">

### Mobile pairing and history

Connection and erasure choices.

<img src="screenshots/mobile-pairing-history.png" width="330" alt="Mobile pairing and history in the Bungee web manager">

### Mobile sharing history

Start/stop classifications and unknown times.

<img src="screenshots/mobile-sharing-history.png" width="330" alt="Mobile sharing history in the Bungee web manager">

### Mobile profile overview

Companion status in the sidebar/profile navigation.

<img src="screenshots/profile-workflow-mobile.png" width="330" alt="Mobile profile overview in the Bungee web manager">

### Mobile server update command

The command wraps and remains copyable.

<img src="screenshots/mobile-server-updates.png" width="330" alt="Mobile server update command in the Bungee web manager">
