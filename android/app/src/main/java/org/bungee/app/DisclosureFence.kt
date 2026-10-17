package org.bungee.app

/** Process-wide revocation fence. Only short reservations/commits run under its
 * monitor; GPS waits and network I/O run outside it. A canceled reservation can
 * never be reused, including after consent is enabled again. */
class DisclosureFence {
    class Stamp internal constructor(internal val generation: Long)
    class Ticket internal constructor(internal val cancel: () -> Unit)
    private var generation = 0L
    private val active = mutableSetOf<Ticket>()
    @Synchronized fun stamp() = Stamp(generation)
    @Synchronized fun <T> checked(stamp: Stamp, allowed: () -> Boolean, action: () -> T): T {
        check(stamp.generation == generation && allowed()) { "Privacy consent changed; operation canceled" }
        return action()
    }
    @Synchronized fun reserve(stamp: Stamp, allowed: () -> Boolean, cancel: () -> Unit, prepare: () -> Unit = {}): Ticket = checked(stamp, allowed) {
        prepare()
        Ticket(cancel).also { active += it }
    }
    @Synchronized fun release(ticket: Ticket) { active.remove(ticket); ticket.cancel() }
    @Synchronized fun <T> change(persist: () -> T): T {
        generation++
        val pending = active.toList()
        active.clear()
        var failure: Exception? = null
        for (ticket in pending) try { ticket.cancel() } catch (e: Exception) { failure = e }
        // Persist withdrawal even if one cancellation hook fails. Do not report success then.
        val result = persist()
        failure?.let { throw it }
        return result
    }
}
object PrivacySends { val fence = DisclosureFence() }
