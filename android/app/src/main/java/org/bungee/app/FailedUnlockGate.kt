package org.bungee.app

/** One attempt per credential-failure streak, at most six attempts per rolling hour.
 * Monotonic time is supplied by Android; nothing here survives process loss. */
class FailedUnlockGate {
    private var baseline = 0
    private var previous = 0
    private var fired = false
    private val attempts = ArrayDeque<Long>()
    fun reset(current: Int = 0) { baseline = current.coerceAtLeast(0); previous = baseline; fired = false }
    fun failed(count: Int, elapsed: Long): Boolean {
        if (count < 0 || elapsed < 0) return false
        if (count < previous) reset()
        previous = count
        if (fired || count.toLong() - baseline < 3) return false
        fired = true // A failed/unavailable camera is not retried within this streak.
        return reserve(elapsed)
    }
    fun test(elapsed: Long): Boolean = elapsed >= 0 && reserve(elapsed)
    private fun reserve(elapsed: Long): Boolean {
        while (attempts.isNotEmpty() && elapsed - attempts.first() >= 3_600_000) attempts.removeFirst()
        if (attempts.lastOrNull()?.let { elapsed - it < 300_000 } == true || attempts.size >= 6) return false
        attempts.addLast(elapsed)
        return true
    }
}
