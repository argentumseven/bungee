package org.bungee.app

import android.app.KeyguardManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.UserManager
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject

/** This build cannot create owner restrictions. The only owner mutations below remove legacy policy. */
object ManagementAgent {
    fun role(context: Context) = ManagementRole.inspect(
        { context.getSystemService(DevicePolicyManager::class.java).isDeviceOwnerApp(context.packageName) },
        { context.getSystemService(DevicePolicyManager::class.java).isProfileOwnerApp(context.packageName) }
    )
    fun blocksPersonalOperation(context: Context) = role(context).blocksOperation
    private fun admin(context: Context) = ComponentName(context, BungeeAdminReceiver::class.java)
    @Synchronized fun report(context: Context, identity: Identity): JSONObject {
        val dpm = context.getSystemService(DevicePolicyManager::class.java)
        val role = role(context)
        val state = identity.state("management")
        val signals = identity.state("unlock")
        val attempts = if (identity.allowCommands) runCatching { dpm.currentFailedPasswordAttempts }.getOrNull() else null
        // Retained photos can exist while the camera service is unavailable after reboot.
        // Do not turn its fresh process-local counters into a false empty-queue report.
        val cameraReport = runCatching {
            val camera = ArmedCameraService.status.value
            val queue = if (LocalSafety.isCameraEnabled(context)) identity.photoQueueReport() else 0 to 0L
            JSONObject().put("armed", camera.armed).put("pending", queue.first).put("dropped", queue.second)
                .put("status", camera.detail.take(80)).put("reported_at", System.currentTimeMillis()/1000)
        }.getOrDefault(JSONObject.NULL) // A broken photo queue must not block ordinary reporting.
        return JSONObject().put("owner", role == ManagementRole.DEVICE_OWNER || role == ManagementRole.PROFILE_OWNER).put("consent", false)
            .put("camera", cameraReport)
            .put("delivery", identity.backlogReport().put("reported_at", System.currentTimeMillis()/1000).put("gps_access", TelemetryService.status.value.gpsAccess))
            .put("recovery_consent", identity.allowCommands && !LocalSafety.isStopped(context)).put("revision", state.optLong("revision", 0))
            .put("dns_active", false).put("always_on", role == ManagementRole.DEVICE_OWNER && runCatching { dpm.getAlwaysOnVpnPackage(admin(context)) == context.packageName }.getOrDefault(false))
            .put("uninstall_blocked", role == ManagementRole.DEVICE_OWNER && runCatching { dpm.isUninstallBlocked(admin(context), context.packageName) }.getOrDefault(false))
            .put("protection_active", false).put("strong_lock_required", false).put("blocked_apps", JSONArray())
            .put("lost_mode_active", state.optBoolean("lost_mode_active") && identity.allowCommands)
            .put("errors", state.optJSONArray("errors") ?: JSONArray())
            .put("android_version", Build.VERSION.RELEASE.take(40)).put("security_patch", Build.VERSION.SECURITY_PATCH.take(20))
            .put("secure_lock", context.getSystemService(KeyguardManager::class.java).isDeviceSecure)
            .put("screen_locked", context.getSystemService(KeyguardManager::class.java).isDeviceLocked)
            .put("unlock_monitoring", attempts != null)
            .put("failed_unlocks", attempts?.coerceAtLeast(0) ?: 0).put("last_failed_at", if (identity.allowCommands) signals.opt("last_failed_at") ?: JSONObject.NULL else JSONObject.NULL)
    }
    @Synchronized fun apply(context: Context, identity: Identity, revision: Long, json: JSONObject) {
        check(!LocalSafety.isStopped(context) && !blocksPersonalOperation(context)) { "Local recovery is required before sharing" }
        require(revision >= 0)
        val policy = DevicePolicy.parse(json)
        val dpm = context.getSystemService(DevicePolicyManager::class.java)
        val state = identity.state("management")
        val previous = state.toString()
        val errors = JSONArray()
        val lost = policy.lostMode && identity.allowCommands
        if (policy.lostMode && !identity.allowCommands) errors.put("Lost mode needs local recovery consent")
        if (lost) {
            if (!state.optBoolean("lost_mode_active") || state.optLong("revision", -1) != revision) {
                runCatching { identity.ifCommandsAllowed {
                    identity.recoveryMessage = policy.recoveryMessage
                    recoveryNotification(context, policy.recoveryMessage)
                } }.onFailure { errors.put("Recovery notification could not be displayed") }
            }
            if (dpm.isAdminActive(admin(context))) {
                if (state.optLong("locked_revision", -1) != revision) {
                    runCatching {
                        // Persist the attempt before actuating: a crash must not repeat this revision's lock.
                        state.put("locked_revision", revision)
                        identity.saveState("management", state)
                        identity.ifCommandsAllowed { LocalSafety.ifAllowed(context) { dpm.lockNow() } }
                    }.onFailure { errors.put("Lost mode could not lock the screen; this revision will not retry") }
                }
            } else errors.put("Optional removable device administration is needed to lock")
        } else if (state.optBoolean("lost_mode_active")) {
            identity.recoveryMessage = null; context.getSystemService(NotificationManager::class.java).cancel(2)
        }
        state.put("revision", revision).put("lost_mode_active", lost).put("errors", errors).put("policy", json)
        if (state.toString() != previous) identity.saveState("management", state)
    }
    fun recoveryNotification(context: Context, message: String) {
        val open = PendingIntent.getActivity(context, 3, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        LocalSafety.ifAllowed(context) { context.getSystemService(NotificationManager::class.java).notify(2, NotificationCompat.Builder(context, "recovery")
            .setSmallIcon(R.drawable.ic_bungee).setContentTitle("Lost phone · contact the household").setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message)).setVisibility(NotificationCompat.VISIBILITY_PUBLIC).setContentIntent(open).setOngoing(true).build()) }
    }
    /** Best effort only; never removes ownership, resets the phone, changes credentials or needs a server. */
    @Synchronized fun releaseLegacy(context: Context): List<String> {
        val dpm = context.getSystemService(DevicePolicyManager::class.java)
        val component = admin(context)
        val actions = mutableListOf<Pair<String, () -> Unit>>()
        val role = role(context)
        if (role == ManagementRole.PROFILE_OWNER || role == ManagementRole.UNKNOWN) return listOf(checkNotNull(role.removalNotice))
        if (role == ManagementRole.DEVICE_OWNER) {
            actions += "Old always-on policy could not be cleared." to { if (dpm.getAlwaysOnVpnPackage(component) == context.packageName) dpm.setAlwaysOnVpnPackage(component, null, false) }
            actions += "Old uninstall protection could not be cleared." to { dpm.setUninstallBlocked(component, context.packageName, false) }
            actions += "Old password-complexity requirement could not be cleared. The actual PIN is never changed." to { dpm.requiredPasswordComplexity = DevicePolicyManager.PASSWORD_COMPLEXITY_NONE }
            actions += "Old lock-screen contact information could not be cleared." to { dpm.setDeviceOwnerLockScreenInfo(component, null) }
            for (key in listOf(UserManager.DISALLOW_CONFIG_PRIVATE_DNS, UserManager.DISALLOW_CONFIG_VPN, UserManager.DISALLOW_SAFE_BOOT, UserManager.DISALLOW_ADD_USER, UserManager.DISALLOW_FACTORY_RESET)) {
                actions += "Old restriction could not be cleared: $key" to { dpm.clearUserRestriction(component, key) }
            }
            try {
                val apps = Identity.readExistingState(context, "management").optJSONArray("blocked_apps") ?: JSONArray()
                for (i in 0 until apps.length()) {
                    val name = apps.getString(i)
                    if (DevicePolicy.safePackage(name)) actions += "Old app could not be restored: $name" to {
                        check(dpm.setPackagesSuspended(component, arrayOf(name), false).isEmpty())
                    }
                }
            } catch (_: Exception) {
                actions += "Old app records could not be read. Preserve the original identity/signing key for recovery." to { error("Existing recovery records unavailable") }
            }
        } else {
            actions += "Device administration is still active or deactivation is pending. Wait, check administration status, or deactivate Bungee in Android Settings." to {
                check(AdminDeactivation.request({ dpm.isAdminActive(component) }, { dpm.removeActiveAdmin(component) }))
            }
        }
        // Quarantine was persisted by local recovery first. This sequence only removes known policy.
        return RecoveryCoordinator.run({}, actions)
    }
    @Synchronized fun release(context: Context) {
        check(!blocksPersonalOperation(context)) { "Device/profile ownership must be resolved before unpairing" }
        val errors = releaseLegacy(context)
        check(errors.isEmpty()) { errors.joinToString("; ") }
        check(!blocksPersonalOperation(context)) { "Management status changed; preserve the identity" }
    }
}
