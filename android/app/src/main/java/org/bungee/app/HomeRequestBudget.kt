package org.bungee.app

/** Ordinary requests stay short; the dedicated larger-photo route gets a bounded minute. */
object HomeRequestBudget {
    const val MAX_MILLIS = 10_000L
    const val PHOTO_MAX_MILLIS = 60_000L
    fun remaining(requested: Long, deadline: Long, now: Long, path: String = ""): Long {
        require(requested > 0 && deadline >= 0 && now >= 0)
        val maximum=if(path=="/v1/photos") PHOTO_MAX_MILLIS else MAX_MILLIS
        return minOf(maximum, requested, deadline-now).also { check(it > 0) { "Request deadline passed before transport" } }
    }
}
