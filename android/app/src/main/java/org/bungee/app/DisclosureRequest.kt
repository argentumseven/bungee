package org.bungee.app

/** The same send orchestration is exercised with a deterministic fake transport
 * on the host and with cancelable native reservations on Android. */
class DisclosureRequest(
    private val fence: DisclosureFence,
    private val reserve: () -> Long,
    private val cancel: (Long) -> Unit
) {
    fun <T> exchange(stamp: DisclosureFence.Stamp, allowed: () -> Boolean, remaining: () -> Long, send: (Long, Long) -> T): T {
        var request = 0L
        val ticket = fence.reserve(stamp, allowed, { if (request != 0L) cancel(request) }, { request = reserve() })
        try {
            val budget = remaining().coerceAtMost(10000)
            check(budget > 0) { "Deadline passed before upload" }
            val result = send(request, budget)
            return fence.checked(stamp, allowed) { result }
        } finally { fence.release(ticket) }
    }
}
