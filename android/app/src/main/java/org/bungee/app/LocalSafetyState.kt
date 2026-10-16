package org.bungee.app

/** Restart consent is invalidated by stop and cannot be restored by merely clearing that stop. */
data class LocalSafetyState(val stopped: Boolean = false, val restartAllowed: Boolean = false) {
    init { require(!stopped || !restartAllowed) }
    fun stop() = LocalSafetyState(stopped = true)
    fun clearStop() = LocalSafetyState()
    fun allowRestart(allowed: Boolean): LocalSafetyState {
        check(!stopped || !allowed)
        return copy(restartAllowed = allowed)
    }
}
