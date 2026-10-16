package org.bungee.app

import kotlin.math.ceil
import kotlin.math.min
import kotlin.random.Random

/** Monotonic retry/bandwidth state; no radio, VPN, wall-clock or Android policy changes. */
class DdilRetry(private val random: () -> Double = { Random.nextDouble() }) {
    var failures = 0; private set
    var nextAttempt = 0L; private set
    var lastAttempt = Long.MIN_VALUE; private set
    var batchSize = 25; private set
    fun attempted(now: Long) { lastAttempt = now }
    fun failed(now: Long, authentication: Boolean = false) {
        failures = (failures + 1).coerceAtMost(30)
        batchSize = (batchSize / 2).coerceAtLeast(1)
        val cap = if (authentication) 900_000L else min(300_000L, 15_000L * (1L shl min(failures - 1, 5)))
        val delay = (cap * (0.8 + random().coerceIn(0.0, 1.0) * 0.2)).toLong()
        nextAttempt = now + delay
    }
    fun succeeded(now: Long, roundTrip: Long) {
        failures = 0
        if (roundTrip < 2_000) batchSize = (batchSize + 5).coerceAtMost(100)
        else if (roundTrip > 5_000) batchSize = (batchSize / 2).coerceAtLeast(1)
        nextAttempt = now + 15_000
    }
    fun networkChanged(now: Long) {
        // A flapping network cannot trigger a tight retry loop or reset failure backoff.
        nextAttempt = min(nextAttempt, if (lastAttempt == Long.MIN_VALUE) now else maxOf(now, lastAttempt + 5_000))
    }
}

/** A conservative home-server time bound, used only for command expiry and GPS eligibility.
 * Device request signatures still use the OS clock and retain the server's replay window. */
class HomeClock {
    private var lower = 0L
    private var upper = 0L
    private var received = 0L
    fun observe(serverSeconds: Long, startElapsed: Long, endElapsed: Long) {
        require(serverSeconds in 1..253402300799 && endElapsed >= startElapsed)
        lower = serverSeconds
        upper = serverSeconds + ceil((endElapsed - startElapsed) / 1000.0).toLong() + 1
        received = endElapsed
    }
    fun upperNow(elapsed: Long): Long {
        check(lower > 0 && elapsed >= received) { "No current authenticated home time" }
        return upper + ceil((elapsed - received) / 1000.0).toLong()
    }
    fun gpsCutoff(elapsed: Long): Long {
        check(lower > 0 && elapsed >= received)
        return lower + (elapsed - received) / 1000 + 60
    }
}
