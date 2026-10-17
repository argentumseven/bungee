package org.bungee.app

data class BootCameraState(val pending: String? = null, val attempted: String? = null, val offered: String? = null, val offeredAt: Long = 0)

/** Claim is durably saved before showing UI. A failed/crashed attempt never launches in a loop. */
class BootCameraGate(private val read: () -> BootCameraState, private val write: (BootCameraState) -> Unit) {
    fun request(key: String) {
        val state = read()
        if (state.attempted != key) write(state.copy(pending = key, offered = null, offeredAt = 0))
    }
    fun launch(key: String, elapsed: Long, allowed: () -> Boolean, show: () -> Unit): Boolean {
        val state = read()
        if (elapsed < 0 || state.pending != key || state.attempted == key || !allowed()) return false
        write(BootCameraState(attempted = key, offered = key, offeredAt = elapsed))
        if (!allowed()) { cancel(); return false }
        show()
        return true
    }
    fun consume(key: String, elapsed: Long, allowed: () -> Boolean): Boolean {
        val state = read()
        if (state.offered == null) return false
        write(state.copy(offered = null, offeredAt = 0))
        return state.offered == key && state.attempted == key && elapsed >= state.offeredAt &&
            elapsed - state.offeredAt <= 30_000 && allowed()
    }
    fun cancel() { write(read().copy(pending = null, offered = null, offeredAt = 0)) }
}
