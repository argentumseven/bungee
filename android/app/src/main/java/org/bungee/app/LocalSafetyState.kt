package org.bungee.app

/** Restart consent is invalidated by stop and cannot be restored by merely clearing that stop. */
data class LocalSafetyState(val stopped: Boolean = false, val restartAllowed: Boolean = false, val cameraEnabled: Boolean = false, val cameraRestartAllowed: Boolean = false) {
    init { require(!stopped || (!restartAllowed && !cameraEnabled)); require(!cameraRestartAllowed || cameraEnabled) }
    val connectionRestartAllowed get() = restartAllowed || cameraEnabled
    fun stop() = LocalSafetyState(stopped = true)
    fun clearStop() = LocalSafetyState()
    fun allowRestart(allowed: Boolean): LocalSafetyState {
        check(!stopped || !allowed)
        return copy(restartAllowed = allowed)
    }
    fun allowCamera(enabled: Boolean): LocalSafetyState {
        check(!stopped || !enabled)
        return copy(cameraEnabled = enabled, cameraRestartAllowed = cameraRestartAllowed && enabled)
    }
    fun allowCameraRestart(allowed: Boolean): LocalSafetyState {
        check(!allowed || (!stopped && cameraEnabled))
        return copy(cameraRestartAllowed = allowed)
    }
}
