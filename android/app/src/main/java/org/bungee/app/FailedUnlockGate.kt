package org.bungee.app

import org.json.JSONArray
import org.json.JSONObject

/** One attempt per credential-failure streak, at most six attempts per rolling hour.
 * Snapshots are restored only within the same OS boot, using monotonic time. */
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
    fun snapshot() = JSONObject().put("baseline", baseline).put("previous", previous).put("fired", fired)
        .put("attempts", JSONArray(attempts.toList()))
    companion object {
        fun restore(state: JSONObject, elapsed: Long): FailedUnlockGate {
            require(elapsed >= 0)
            return FailedUnlockGate().apply {
                baseline = state.getInt("baseline"); previous = state.getInt("previous"); fired = state.getBoolean("fired")
                require(baseline >= 0 && previous >= baseline)
                val saved = state.getJSONArray("attempts")
                require(saved.length() <= 6)
                for (i in 0 until saved.length()) {
                    val time = saved.getLong(i)
                    require(time in 0..elapsed && (attempts.lastOrNull()?.let { time - it >= 300_000 } != false))
                    attempts.addLast(time)
                }
            }
        }
    }
    private fun reserve(elapsed: Long): Boolean {
        while (attempts.isNotEmpty() && elapsed - attempts.first() >= 3_600_000) attempts.removeFirst()
        if (attempts.lastOrNull()?.let { elapsed - it < 300_000 } == true || attempts.size >= 6) return false
        attempts.addLast(elapsed)
        return true
    }
}
