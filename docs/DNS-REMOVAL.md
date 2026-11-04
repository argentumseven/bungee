# Removing the retired DNS feature

Version 1.1.17 removes DNS routing, relay listeners, probes, logs, manager navigation, per-phone controls and installation prompts. Bungee no longer changes Android DNS. Existing DNS tables and pending DNS diagnostics are removed during the server upgrade; pairing, GPS/IP history and recovery photos are preserved. Old host DNS answers are discarded automatically.

If DNS was never enabled, update normally. No domain, certificate, ADB grant or resolver configuration is needed.

If a previous version changed a phone's Private DNS, restore it before stopping the old relay: use **Remove DNS setup** in the old phone app, or select **Automatic** in Android's Private DNS settings. The host upgrade refuses to retire an old configured relay while its records still indicate unresolved phone settings. Reconnect the phone with the old app long enough to confirm restoration before retrying the host upgrade. A phone that was removed from pairing still needs local restoration.

The updated app also runs a restore-only migration at startup, independently of pairing or connectivity. It restores the saved setting only while Bungee still owns the current setting, preserves manual Android changes, and clears the undo record after verification. Failed restoration keeps the undo record and offers recovery in **Pairing & recovery**. The old WRITE_SECURE_SETTINGS declaration remains solely for this migration so Android does not revoke an existing grant before cleanup; no new grant or activation UI is provided.

If Android refuses automatic recovery, select **Automatic** in its Private DNS settings, return to Bungee and retry local recovery before uninstalling or clearing app data. A computer can set Automatic explicitly:

```sh
adb shell settings put global private_dns_mode opportunistic
adb shell settings delete global private_dns_specifier
```

After restoration, the old ADB grant can be revoked:

```sh
adb shell pm revoke org.bungee.app android.permission.WRITE_SECURE_SETTINGS
```

Uninstalling or clearing data cannot execute app cleanup. DNS selection after removal is controlled by Android, your network and any other VPN or DNS app.
