package org.bungee.app

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.os.Process
import android.os.UserHandle
import org.json.JSONObject

/** OS-protected credential callbacks. No biometric assumptions or credential contents are read. */
class BungeeAdminReceiver : DeviceAdminReceiver() {
    override fun onPasswordFailed(context: Context, intent: Intent, user: UserHandle) {
        if (user != Process.myUserHandle() || LocalSafety.isStopped(context)) return
        runCatching {
            val identity = Identity(context)
            if (!identity.enrolled || !identity.allowCommands) return
            val attempts = context.getSystemService(DevicePolicyManager::class.java).currentFailedPasswordAttempts
            identity.saveState("unlock", JSONObject().put("failed", attempts.coerceAtLeast(0)).put("last_failed_at", System.currentTimeMillis() / 1000))
            ArmedCameraService.passwordFailed(attempts)
        }
    }
    override fun onPasswordSucceeded(context: Context, intent: Intent, user: UserHandle) {
        if (user != Process.myUserHandle() || LocalSafety.isStopped(context)) return
        runCatching { val identity = Identity(context); val signals = identity.state("unlock"); signals.put("failed", 0); identity.saveState("unlock", signals) }
        ArmedCameraService.passwordSucceeded()
    }
    override fun onDisabled(context: Context, intent: Intent) { runCatching { ArmedCameraService.disarm(context) } }
}
