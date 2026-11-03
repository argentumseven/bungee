package org.bungee.app

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.provider.Settings

/** Uses official UI-start access; camera authority comes from the resumed startup activity. */
object CameraBootRecovery {
    private fun key(context: Context) = "${Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT)}:${BuildConfig.VERSION_CODE}"
    private fun gate(context: Context): BootCameraGate {
        val prefs = context.getSharedPreferences("camera-boot", Context.MODE_PRIVATE)
        return BootCameraGate({ BootCameraState(prefs.getString("pending", null), prefs.getString("attempted", null), prefs.getString("offered", null), prefs.getLong("offered_at", 0)) }, {
            check(prefs.edit().putString("pending", it.pending).putString("attempted", it.attempted)
                .putString("offered", it.offered).putLong("offered_at", it.offeredAt).commit()) { "Camera startup state could not be saved" }
        })
    }
    fun hasStartupAccess(context: Context) = runCatching { Settings.canDrawOverlays(context) }.getOrDefault(false)
    fun allowed(context: Context): Boolean = runCatching {
        !LocalSafety.isStopped(context) && LocalSafety.isCameraEnabled(context) && LocalSafety.isCameraRestartAllowed(context) &&
            hasStartupAccess(context) && !ManagementAgent.blocksPersonalOperation(context)
    }.getOrDefault(false)
    @Synchronized fun request(context: Context): Boolean = runCatching {
        if (!allowed(context)) return false
        gate(context).request(key(context))
        resumePending(context)
        true
    }.getOrDefault(false)
    @Synchronized fun resumePending(context: Context) {
        runCatching {
            if (!allowed(context) || context.getSystemService(KeyguardManager::class.java).isDeviceLocked) return
            if (ArmedCameraService.currentSession() != null) { gate(context).cancel(); return }
            val stamp = PrivacySends.fence.stamp()
            PrivacySends.fence.checked(stamp, { allowed(context) }) {
                gate(context).launch(key(context), SystemClock.elapsedRealtime(), { allowed(context) && !context.getSystemService(KeyguardManager::class.java).isDeviceLocked }) {
                    context.startActivity(Intent(context, CameraRecoveryActivity::class.java).putExtra("request_key", key(context))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS))
                }
            }
        }.onFailure { ArmedCameraService.refreshReadiness(context,"automatic startup was restricted; open Bungee") }
    }
    @Synchronized fun consume(context: Context, requestKey: String?): Boolean = runCatching {
        if (requestKey != key(context)) return false
        gate(context).consume(key(context), SystemClock.elapsedRealtime()) {
            allowed(context) && !context.getSystemService(KeyguardManager::class.java).isDeviceLocked
        }
    }.getOrDefault(false)
    @Synchronized fun cancel(context: Context) { gate(context).cancel() }
}
