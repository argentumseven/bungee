package org.bungee.app

import org.json.JSONArray
import org.json.JSONObject

/** More pictures require fresh failed entries; no timer-driven capture loop.
 * Snapshots are restored only within the same OS boot, using monotonic time. */
class FailedUnlockGate {
    private var baseline = 0
    private var previous = 0
    private var lastTrigger = 0
    private val attempts = ArrayDeque<Long>()
    val progress: Int get() = (previous - lastTrigger).coerceIn(0, 3)
    fun reset(current: Int = 0) { baseline = current.coerceAtLeast(0); previous = baseline; lastTrigger = baseline }
    fun failed(count: Int, elapsed: Long): Boolean {
        if (count < 0 || elapsed < 0) return false
        if (count < previous) reset()
        previous = count
        if (count.toLong() - lastTrigger < 3 || !reserve(elapsed)) return false
        lastTrigger = count
        return true
    }
    fun test(elapsed: Long): Boolean = elapsed >= 0 && reserve(elapsed)
    fun snapshot() = JSONObject().put("baseline", baseline).put("previous", previous).put("last_trigger", lastTrigger)
        .put("fired", lastTrigger > baseline) // Old checkpoints remain readable during an upgrade.
        .put("attempts", JSONArray(attempts.toList()))
    companion object {
        fun restore(state: JSONObject, elapsed: Long): FailedUnlockGate {
            require(elapsed >= 0)
            return FailedUnlockGate().apply {
                baseline = state.getInt("baseline"); previous = state.getInt("previous")
                require(baseline >= 0 && previous >= baseline)
                lastTrigger = if (state.has("last_trigger")) state.getInt("last_trigger") else if (state.getBoolean("fired")) previous else baseline
                require(lastTrigger in baseline..previous)
                val saved = state.getJSONArray("attempts")
                require(saved.length() <= RecoveryPhotoPolicy.MAX_ATTEMPTS_PER_HOUR)
                for (i in 0 until saved.length()) {
                    val time = saved.getLong(i)
                    require(time in 0..elapsed && (attempts.lastOrNull()?.let { time - it >= RecoveryPhotoPolicy.MIN_INTERVAL_MILLIS } != false))
                    attempts.addLast(time)
                }
            }
        }
    }
    private fun reserve(elapsed: Long): Boolean {
        while (attempts.isNotEmpty() && elapsed - attempts.first() >= 3_600_000) attempts.removeFirst()
        if (attempts.lastOrNull()?.let { elapsed - it < RecoveryPhotoPolicy.MIN_INTERVAL_MILLIS } == true || attempts.size >= RecoveryPhotoPolicy.MAX_ATTEMPTS_PER_HOUR) return false
        attempts.addLast(elapsed)
        return true
    }
}
