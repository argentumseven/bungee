package org.bungee.app

/** The same send orchestration is exercised with a deterministic fake transport
 * on the host and with cancelable native reservations on Android. */
class DisclosureRequest(
    private val fence: DisclosureFence,
    private val reserve: () -> Long,
    private val cancel: (Long) -> Unit
) {
    /** [maxMillis] bounds one send; only the dedicated photo route may raise it above ten seconds. */
    fun <T> exchange(stamp: DisclosureFence.Stamp, allowed: () -> Boolean, remaining: () -> Long, maxMillis: Long = DEFAULT_MAX_MILLIS, send: (Long, Long) -> T): T {
        var request = 0L
        val ticket = fence.reserve(stamp, allowed, { if (request != 0L) cancel(request) }, { request = reserve() })
        try {
            val budget = remaining().coerceAtMost(maxMillis)
            check(budget > 0) { "Deadline passed before upload" }
            val result = send(request, budget)
            return fence.checked(stamp, allowed) { result }
        } finally { fence.release(ticket) }
    }
    companion object { const val DEFAULT_MAX_MILLIS = 10_000L }
}
