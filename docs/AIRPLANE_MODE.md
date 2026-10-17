# Airplane-mode control on GrapheneOS

The requested cycle is: observe airplane mode, temporarily turn it off, report to the home server and receive permitted commands, then restore airplane mode. **Official app and MDM permissions do not provide that complete cycle on the checked Android/GrapheneOS implementations.** This is an OS authority boundary, separate from whether Bungee enables device-owner enrollment.

The selected scope is official app/MDM permissions only. Bungee adds no shell/ADB bridge, Shizuku integration, root requirement, privileged installation or scheduled airplane-mode toggle. Ordinary pairing, sharing and consented recovery commands keep their existing permission requirements.

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

## Why a permission-gated switch is insufficient

An optional feature can and should leave lower-permission operation available. However, the elevation gate still needs an authority the operator can actually grant. A normal permission prompt, ordinary device administration, or device-owner enrollment does not provide the missing full-cycle API here. Bungee therefore does not present a usable C2 switch with an unavailable official grant path.

Applying `DISALLOW_AIRPLANE_MODE` and promising a later restoration would be incorrect: removing the policy does not turn airplane mode back on. It would also introduce a persistent management restriction that Bungee's recovery contract currently rejects. Bungee does not apply that workaround.

ADB/shell identity is a technically different route. The checked Shell package requests `NETWORK_SETTINGS`, and the connectivity service exposes an airplane-mode shell command. A user-approved shell bridge can therefore be investigated separately from official app/MDM permissions. That route was explicitly excluded for this request and is not integrated or tested in Bungee. Root and platform customization are also outside the selected scope.

Turning airplane mode off would restore networking for the phone generally, including other applications. Bungee's app-contained tunnel would not make that a Bungee-only connectivity window. Scheduling also would not create coverage, unlock a SIM, bypass another VPN's filtering, work while powered off, or guarantee exact wake times under Android power management.

## Source evidence and verification scope

The review inspected Android 16 source, matching the app's current target API, and the GrapheneOS Android 17 source below. It made no radio changes and used no real phone. This is source verification of the permission/policy boundary, not an on-device acceptance test.

- [GrapheneOS framework permission declarations](https://github.com/GrapheneOS/platform_frameworks_base/blob/ef402132a86b78aa4627daa823766e79b1f601e1/core/res/AndroidManifest.xml): protected airplane-mode broadcast; networking, settings and policy permission protection levels.
- [GrapheneOS connectivity implementation](https://github.com/GrapheneOS/platform_packages_modules_Connectivity/blob/6ab5be47d49a3f93d424f195958dfaadec8a906c/service/src/com/android/server/ConnectivityService.java): `enforceAirplaneModePermission`, `setAirplaneMode`, and the shell command handler.
- [GrapheneOS device-policy implementation](https://github.com/GrapheneOS/platform_frameworks_base/blob/ef402132a86b78aa4627daa823766e79b1f601e1/services/devicepolicy/java/com/android/server/devicepolicy/DevicePolicyManagerService.java): `GLOBAL_SETTINGS_ALLOWLIST` and `setGlobalSetting` reject unsupported settings for ordinary managed installations.
- [GrapheneOS restriction application](https://github.com/GrapheneOS/platform_frameworks_base/blob/ef402132a86b78aa4627daa823766e79b1f601e1/services/core/java/com/android/server/pm/UserRestrictionsUtils.java): the `DISALLOW_AIRPLANE_MODE` branch acts when the restriction becomes true; clearing it has no state-restoration branch.
- [GrapheneOS user-restriction API documentation](https://github.com/GrapheneOS/platform_frameworks_base/blob/ef402132a86b78aa4627daa823766e79b1f601e1/core/java/android/os/UserManager.java): eligibility and meaning of `DISALLOW_AIRPLANE_MODE`.
- [GrapheneOS Shell permissions](https://github.com/GrapheneOS/platform_frameworks_base/blob/ef402132a86b78aa4627daa823766e79b1f601e1/packages/Shell/AndroidManifest.xml): the shell identity's networking authority differs from an enrolled app's authority.
- [Android 16 framework permissions](https://github.com/aosp-mirror/platform_frameworks_base/blob/android16-release/core/res/AndroidManifest.xml) and [device-policy implementation](https://github.com/aosp-mirror/platform_frameworks_base/blob/android16-release/services/devicepolicy/java/com/android/server/devicepolicy/DevicePolicyManagerService.java): the corresponding permission protection and settings allowlist.

If upstream introduces an official reversible API for both directions, this feature can be reassessed against that API and the local recovery contract. No such grant path was found in the inspected sources.
