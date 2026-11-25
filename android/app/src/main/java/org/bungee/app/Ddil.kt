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
    private var authenticationNotBefore = 0L
    fun attempted(now: Long) { lastAttempt = now }
    /** A failed connection or poll says nothing about how much data fits; only [uploadFailed] shrinks a batch. */
    fun failed(now: Long, authentication: Boolean = false) {
        failures = (failures + 1).coerceAtMost(30)
        val cap = if (authentication) 900_000L else min(300_000L, 15_000L * (1L shl min(failures - 1, 5)))
        val delay = (cap * (0.8 + random().coerceIn(0.0, 1.0) * 0.2)).toLong()
        nextAttempt = now + delay
        if (authentication) authenticationNotBefore = nextAttempt
        nextAttempt = maxOf(nextAttempt, authenticationNotBefore)
    }
    /** [more] means saved GPS remains and the link carried the last batch quickly: come back soon instead of waiting a full cycle. */
    fun succeeded(now: Long, more: Boolean = false) {
        failures = 0
        authenticationNotBefore = 0
        nextAttempt = now + if (more) 2_000 else 15_000
    }
    /** Sizes the next batch from the upload request itself, not from tunnel setup or polling. */
    fun uploaded(requestMillis: Long) {
        if (requestMillis < 2_000) batchSize = (batchSize + 25).coerceAtMost(100)
        else if (requestMillis > 5_000) batchSize = (batchSize / 2).coerceAtLeast(1)
    }
    fun uploadFailed() { batchSize = (batchSize / 2).coerceAtLeast(1) }
    fun networkChanged(now: Long) {
        // A flapping network cannot trigger a tight retry loop or reset failure backoff.
        nextAttempt = maxOf(authenticationNotBefore, min(nextAttempt, if (lastAttempt == Long.MIN_VALUE) now else maxOf(now, lastAttempt + 5_000)))
    }
}

/**
 * After an outage the saved GPS trail is sent in several bounded batches per connection cycle,
 * not one batch per fifteen seconds. Draining stops when a batch was slow, nothing was sent, or
 * the cycle's own budget is nearly used, so commands and receipts keep their priority.
 */
object DdilDrain {
    const val FAST_MILLIS = 3_000L
    const val BUDGET_MILLIS = 20_000L
    const val MAX_BATCHES = 60
    const val MIN_REMAINING_MILLIS = 12_000L
    fun shouldContinue(sent: Int, queued: Int, requestMillis: Long, drainedMillis: Long, batches: Int, remainingMillis: Long) =
        sent > 0 && queued > 0 && requestMillis <= FAST_MILLIS && drainedMillis < BUDGET_MILLIS &&
            batches < MAX_BATCHES && remainingMillis >= MIN_REMAINING_MILLIS
    /** Whether the next connection cycle should start early: more is waiting and the link is not struggling. */
    fun comeBackSoon(sent: Int, queued: Int, requestMillis: Long) = sent > 0 && queued > 0 && requestMillis <= FAST_MILLIS
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
