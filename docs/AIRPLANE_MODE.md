# Airplane-mode control on GrapheneOS

Bungee cannot temporarily disable airplane mode, report home and restore airplane mode through official app/MDM permissions. Direct two-way control requires protected system networking authority. Device-owner enrollment and a foreground service do not grant it.

The app uses no shell/ADB bridge, Shizuku, root or privileged installation. Pairing, sharing and recovery commands remain available under their ordinary permissions.

## Available authority

| Operation | Official app / management API behavior |
| --- | --- |
| Observe the airplane-mode setting | An ordinary app can read `Settings.Global.AIRPLANE_MODE_ON`. Observation does not grant control and is not proof of internet access or the state of every radio. |
| Open airplane-mode settings | An ordinary app can open the system settings UI. The user changes the setting; this is not unattended scheduling. |
| Prevent airplane mode through eligible management authority | `UserManager.DISALLOW_AIRPLANE_MODE` can prohibit enabling it. Applying the restriction also turns airplane mode off if it is on. This is a persistent restriction, not a temporary reporting window. |
| Remove that management restriction | Clearing it permits user changes again. The implementation does **not** restore the earlier airplane-mode-on state. |
| Change airplane mode directly in both directions | `ConnectivityService.setAirplaneMode` enforces protected networking permissions. The relevant `NETWORK_AIRPLANE_MODE` and `NETWORK_SETTINGS` permissions are `signature`; `NETWORK_SETUP_WIZARD` is `signature\|setup`. They are not ordinary user-grantable permissions or permissions conferred by device-owner enrollment. |
| Write an arbitrary global setting through device-owner APIs | `DevicePolicyManager.setGlobalSetting` uses an allowlist. `AIRPLANE_MODE_ON` is absent for ordinary managed installations. |

`MANAGE_DEVICE_POLICY_AIRPLANE_MODE` also exists. Its name can be misleading for this use case: it is an `internal|role` permission associated with policy management, including the restriction above. Its existence does not grant the direct networking permission or add an API to restore airplane mode on a timer.

`WRITE_SECURE_SETTINGS` is a different permission. Writing a database flag alone is not the supported airplane-mode transition: the checked connectivity implementation updates the setting and sends the protected `ACTION_AIRPLANE_MODE_CHANGED` broadcast. A settings-write recipe is not evidence that a normal app can reliably perform the complete radio transition.

## Why Bungee leaves this unavailable

An optional permission gate would need an authority the user can grant. A normal permission prompt, removable device administration and device ownership cannot supply the complete cycle. Applying `DISALLOW_AIRPLANE_MODE` forces airplane mode off, but clearing it does not restore the prior on state. Bungee also rejects this persistent restriction under its [recovery requirements](SAFETY.md).

The shell identity has different networking authority and an airplane-mode command; Bungee does not integrate that route. Writing `AIRPLANE_MODE_ON` alone also omits the checked connectivity transition and protected broadcast.

Turning airplane mode off would restore connectivity for other applications too. A Bungee tunnel cannot confine that radio window to its own traffic. Coverage, SIM state, another VPN and Android wake scheduling would still affect contact.

## Source evidence and verification scope

The sources below cover Android 16 (the target API) and GrapheneOS Android 17. They establish the permission checks in source. No radio changes or physical-device tests were performed.

- [GrapheneOS framework permission declarations](https://github.com/GrapheneOS/platform_frameworks_base/blob/ef402132a86b78aa4627daa823766e79b1f601e1/core/res/AndroidManifest.xml): protected airplane-mode broadcast; networking, settings and policy permission protection levels.
- [GrapheneOS connectivity implementation](https://github.com/GrapheneOS/platform_packages_modules_Connectivity/blob/6ab5be47d49a3f93d424f195958dfaadec8a906c/service/src/com/android/server/ConnectivityService.java): `enforceAirplaneModePermission`, `setAirplaneMode`, and the shell command handler.
- [GrapheneOS device-policy implementation](https://github.com/GrapheneOS/platform_frameworks_base/blob/ef402132a86b78aa4627daa823766e79b1f601e1/services/devicepolicy/java/com/android/server/devicepolicy/DevicePolicyManagerService.java): `GLOBAL_SETTINGS_ALLOWLIST` and `setGlobalSetting` reject unsupported settings for ordinary managed installations.
- [GrapheneOS restriction application](https://github.com/GrapheneOS/platform_frameworks_base/blob/ef402132a86b78aa4627daa823766e79b1f601e1/services/core/java/com/android/server/pm/UserRestrictionsUtils.java): the `DISALLOW_AIRPLANE_MODE` branch acts when the restriction becomes true; clearing it has no state-restoration branch.
- [GrapheneOS user-restriction API documentation](https://github.com/GrapheneOS/platform_frameworks_base/blob/ef402132a86b78aa4627daa823766e79b1f601e1/core/java/android/os/UserManager.java): eligibility and meaning of `DISALLOW_AIRPLANE_MODE`.
- [GrapheneOS Shell permissions](https://github.com/GrapheneOS/platform_frameworks_base/blob/ef402132a86b78aa4627daa823766e79b1f601e1/packages/Shell/AndroidManifest.xml): the shell identity's networking authority differs from an enrolled app's authority.
- [Android 16 framework permissions](https://github.com/aosp-mirror/platform_frameworks_base/blob/android16-release/core/res/AndroidManifest.xml) and [device-policy implementation](https://github.com/aosp-mirror/platform_frameworks_base/blob/android16-release/services/devicepolicy/java/com/android/server/devicepolicy/DevicePolicyManagerService.java): the corresponding permission protection and settings allowlist.

Reassess this feature if Android adds a user-grantable, reversible API for both directions.
