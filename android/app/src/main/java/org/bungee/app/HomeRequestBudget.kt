package org.bungee.app

/** The native fixed-home transport accepts at most ten seconds per HTTP request. */
object HomeRequestBudget {
    const val MAX_MILLIS = 10_000L
    fun remaining(requested: Long, deadline: Long, now: Long): Long {
        require(requested > 0 && deadline >= 0 && now >= 0)
        return minOf(MAX_MILLIS, requested, deadline-now).also { check(it > 0) { "Request deadline passed before transport" } }
    }
}
