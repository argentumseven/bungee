package org.bungee.app

import android.content.Context

/** Independent non-secret stop and restart consent; pairing keys and server responses cannot clear it. */
object LocalSafety {
    @Volatile private var storageFailed = false
    @Synchronized private fun read(context: Context): LocalSafetyState = try {
        check(!storageFailed)
        val prefs = context.getSharedPreferences("local-safety", Context.MODE_PRIVATE)
        LocalSafetyState(prefs.getBoolean("stopped", false), prefs.getBoolean("restart_allowed", false), prefs.getBoolean("camera_enabled", false))
    } catch (_: Exception) { LocalSafetyState(stopped = true) }
    private fun write(context: Context, state: LocalSafetyState) {
        storageFailed = true
        check(context.getSharedPreferences("local-safety", Context.MODE_PRIVATE).edit()
            .putBoolean("stopped", state.stopped).putBoolean("restart_allowed", state.restartAllowed)
            .putBoolean("camera_enabled", state.cameraEnabled).commit()) { "Local recovery state could not be saved" }
        storageFailed = false
    }
    fun isStopped(context: Context) = read(context).stopped
    fun isRestartAllowed(context: Context) = read(context).restartAllowed
    fun isCameraEnabled(context: Context) = read(context).cameraEnabled
    fun isConnectionRestartAllowed(context: Context) = read(context).connectionRestartAllowed
    @Synchronized fun <T> ifAllowed(context: Context, action: () -> T): T {
        check(!isStopped(context)) { "Bungee is stopped locally" }
        return action()
    }
    fun setStopped(context: Context, stopped: Boolean) = PrivacySends.fence.change { synchronized(this) {
        write(context, if (stopped) read(context).stop() else read(context).clearStop())
    } }
    @Synchronized fun setRestartAllowed(context: Context, allowed: Boolean) { write(context, read(context).allowRestart(allowed)) }
    fun setCameraEnabled(context: Context, enabled: Boolean) = PrivacySends.fence.change { synchronized(this) {
        write(context, read(context).allowCamera(enabled))
    } }
}
