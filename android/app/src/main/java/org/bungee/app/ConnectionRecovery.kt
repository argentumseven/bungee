package org.bungee.app

/** Empty until a peer exists. Local recovery can close it without loading a transport backend. */
class ConnectionRecovery(private val fence: DisclosureFence) {
    private var close: (() -> Unit)? = null
    fun open(allowed: () -> Boolean, configure: () -> Unit, release: () -> Unit, publish: () -> Unit) {
        val stamp = fence.stamp()
        fence.checked(stamp, allowed) { }
        configure()
        try {
            fence.checked(stamp, allowed) {
                synchronized(this) { close = release }
                publish()
            }
        } catch (e: Exception) {
            release()
            throw e
        }
    }
    fun stop() {
        val action = synchronized(this) { close }
        action?.invoke() // Never hold this monitor while entering the connection's monitor.
    }
    @Synchronized fun clear() { close = null }
}
object RecoveryConnection { val current = ConnectionRecovery(PrivacySends.fence) }
