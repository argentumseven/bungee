package org.bungee.app

import android.app.KeyguardManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.UserManager
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject

/** Finite, disclosed policies. No scripts, credential resets, remote wipes or arbitrary settings. */
object ManagementAgent {
    fun isOwner(context: Context) = context.getSystemService(DevicePolicyManager::class.java).isDeviceOwnerApp(context.packageName)
    private fun admin(context: Context) = ComponentName(context, BungeeAdminReceiver::class.java)
    @Synchronized fun report(context: Context, identity: Identity): JSONObject {
        val dpm = context.getSystemService(DevicePolicyManager::class.java)
        val owner = isOwner(context)
        val state = identity.state("management")
        val signals = identity.state("unlock")
        val attempts = if (identity.allowCommands) runCatching { dpm.currentFailedPasswordAttempts }.getOrNull() else null
        return JSONObject().put("owner", owner).put("consent", identity.managementConsent)
            .put("recovery_consent", identity.allowCommands).put("revision", state.optLong("revision", 0))
            .put("dns_active", owner && identity.managementConsent && identity.managedDns && HomeTunnel.managedDnsActive && HomeTunnel.state == com.wireguard.android.backend.Tunnel.State.UP)
            .put("always_on", owner && runCatching { dpm.getAlwaysOnVpnPackage(admin(context)) == context.packageName }.getOrDefault(false))
            .put("uninstall_blocked", owner && runCatching { dpm.isUninstallBlocked(admin(context), context.packageName) }.getOrDefault(false))
            .put("protection_active", state.optBoolean("protection_active") && owner && identity.managementConsent)
            .put("strong_lock_required", owner && runCatching { dpm.requiredPasswordComplexity == DevicePolicyManager.PASSWORD_COMPLEXITY_HIGH }.getOrDefault(false))
            .put("blocked_apps", state.optJSONArray("blocked_apps") ?: JSONArray())
            .put("lost_mode_active", state.optBoolean("lost_mode_active") && identity.allowCommands)
            .put("errors", JSONArray((state.optJSONArray("errors") ?: JSONArray()).let { items -> (0 until minOf(items.length(), 20)).map { items.optString(it).take(160) } }))
            .put("android_version", Build.VERSION.RELEASE.take(40)).put("security_patch", Build.VERSION.SECURITY_PATCH.take(20))
            .put("secure_lock", context.getSystemService(KeyguardManager::class.java).isDeviceSecure)
            .put("screen_locked", context.getSystemService(KeyguardManager::class.java).isDeviceLocked)
            .put("unlock_monitoring", attempts != null)
            .put("failed_unlocks", attempts?.coerceAtLeast(0) ?: 0).put("last_failed_at", if (identity.allowCommands) signals.opt("last_failed_at") ?: JSONObject.NULL else JSONObject.NULL)
    }
    @Synchronized fun apply(context: Context, identity: Identity, revision: Long, json: JSONObject, dnsAvailable: Boolean) {
        require(revision >= 0)
        val policy = DevicePolicy.parse(json)
        val dpm = context.getSystemService(DevicePolicyManager::class.java)
        val component = admin(context)
        val state = identity.state("management")
        val errors = JSONArray()
        fun attempt(label: String, action: () -> Unit): Boolean = try { action(); true } catch (_: Exception) { errors.put(label); false }
        val owner = isOwner(context)
        val manage = owner && identity.managementConsent
        if (manage) {
            var dnsReady = false
            if (policy.managedDns) {
                dnsReady = attempt("Home DNS or Android Private DNS could not be configured") {
                    check(dnsAvailable)
                    if (dpm.getGlobalPrivateDnsMode(component) != DevicePolicyManager.PRIVATE_DNS_MODE_OPPORTUNISTIC) {
                        check(dpm.setGlobalPrivateDnsModeOpportunistic(component) == DevicePolicyManager.PRIVATE_DNS_SET_NO_ERROR)
                    }
                }
            }
            identity.managedDns = policy.managedDns && dnsReady
            attempt("Always-on VPN could not be applied") {
                val current = dpm.getAlwaysOnVpnPackage(component)
                if (policy.alwaysOn && current != context.packageName) dpm.setAlwaysOnVpnPackage(component, context.packageName, false)
                if (!policy.alwaysOn && current == context.packageName) dpm.setAlwaysOnVpnPackage(component, null, false)
            }
            if (identity.managedDns && dpm.getAlwaysOnVpnPackage(component) != context.packageName) identity.managedDns = false
            attempt("Uninstall protection could not be applied") {
                if (dpm.isUninstallBlocked(component, context.packageName) != policy.preventUninstall) dpm.setUninstallBlocked(component, context.packageName, policy.preventUninstall)
            }
            val restrictions = mapOf(
                UserManager.DISALLOW_CONFIG_PRIVATE_DNS to identity.managedDns,
                UserManager.DISALLOW_CONFIG_VPN to (identity.managedDns || policy.alwaysOn || policy.protectSettings),
                UserManager.DISALLOW_SAFE_BOOT to policy.protectSettings,
                UserManager.DISALLOW_ADD_USER to policy.protectSettings,
                UserManager.DISALLOW_FACTORY_RESET to policy.protectSettings
            )
            val protected = attempt("Recovery settings protection could not be applied") {
                val applied = dpm.getUserRestrictions(component)
                restrictions.forEach { (key, enabled) -> if (applied.getBoolean(key) != enabled) {
                    if (enabled) dpm.addUserRestriction(component, key) else dpm.clearUserRestriction(component, key)
                } }
            }
            state.put("protection_active", protected && policy.protectSettings)
            attempt("Screen-lock complexity requirement could not be applied") {
                val complexity = if (policy.requireStrongLock) DevicePolicyManager.PASSWORD_COMPLEXITY_HIGH else DevicePolicyManager.PASSWORD_COMPLEXITY_NONE
                if (dpm.requiredPasswordComplexity != complexity) dpm.requiredPasswordComplexity = complexity
            }
            val previous = state.optJSONArray("blocked_apps") ?: JSONArray()
            val old = (0 until previous.length()).map { previous.getString(it) }.toSet()
            val applied = old.toMutableSet()
            for (name in old - policy.blockedApps) attempt("A previously suspended app could not be restored") {
                check(dpm.setPackagesSuspended(component, arrayOf(name), false).isEmpty()); applied.remove(name)
            }
            for (name in policy.blockedApps) attempt("Selected app could not be suspended: $name") {
                require(DevicePolicy.safePackage(name))
                check(applied.contains(name) || applied.size < 20)
                val info = context.packageManager.getApplicationInfo(name, 0)
                check(info.flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) == 0)
                check(dpm.setPackagesSuspended(component, arrayOf(name), true).isEmpty()); applied.add(name)
            }
            state.put("blocked_apps", JSONArray(applied.sorted()))
        } else {
            identity.managedDns = false
            if (policy.managedDns || policy.alwaysOn || policy.preventUninstall || policy.protectSettings || policy.requireStrongLock || policy.blockedApps.isNotEmpty()) errors.put("Managed policies need device ownership and local approval")
        }
        identity.autoResume = identity.resumeConsent || (manage && policy.autoResume)
        if (policy.autoResume && !manage && !identity.resumeConsent) errors.put("Automatic recovery restart needs local approval")
        val lost = policy.lostMode && identity.allowCommands
        if (policy.lostMode && !identity.allowCommands) errors.put("Lost mode needs local recovery consent")
        if (owner) attempt("Lock-screen recovery information could not be applied") { dpm.setDeviceOwnerLockScreenInfo(component, if (lost) policy.recoveryMessage else null) }
        if (lost) {
            val changed = !state.optBoolean("lost_mode_active") || state.optLong("revision", -1) != revision
            if (changed) {
                identity.recoveryMessage = policy.recoveryMessage
                attempt("Recovery notification could not be displayed") { recoveryNotification(context, policy.recoveryMessage) }
            }
            if (dpm.isAdminActive(component)) attempt("Lost mode could not lock the screen") {
                if (state.optLong("locked_revision", -1) != revision) { dpm.lockNow(); state.put("locked_revision", revision) }
            } else errors.put("Android device administration is needed to lock in lost mode")
        } else if (state.optBoolean("lost_mode_active")) {
            identity.recoveryMessage = null
            context.getSystemService(NotificationManager::class.java).cancel(2)
        }
        state.put("revision", revision).put("lost_mode_active", lost).put("errors", errors).put("policy", json)
        identity.saveState("management", state)
    }
    fun recoveryNotification(context: Context, message: String) {
        val open = PendingIntent.getActivity(context, 3, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        context.getSystemService(NotificationManager::class.java).notify(2, NotificationCompat.Builder(context, "recovery")
            .setSmallIcon(R.drawable.ic_bungee).setContentTitle("Lost phone · contact the household").setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message)).setVisibility(NotificationCompat.VISIBILITY_PUBLIC).setContentIntent(open).setOngoing(true).build())
    }
    @Synchronized fun release(context: Context, identity: Identity) {
        check(isOwner(context))
        // Clear only Bungee's finite policy set before withdrawing consent. Never reset the phone.
        apply(context, identity, identity.state("management").optLong("revision", 0), JSONObject(), false)
        val errors = identity.state("management").optJSONArray("errors")
        check(errors == null || errors.length() == 0) { "Some policies could not be released; review management status" }
        identity.managementConsent = false; identity.managedDns = false
    }
}
