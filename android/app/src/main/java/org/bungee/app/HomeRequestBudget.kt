package org.bungee.app

/** Ordinary requests stay short; the photo route gets a bounded minute and an APK chunk half a minute,
 * so a weak link can finish them. These match the limits the native transport enforces. */
object HomeRequestBudget {
    const val MAX_MILLIS = 10_000L
    const val PHOTO_MAX_MILLIS = 60_000L
    const val CHUNK_MAX_MILLIS = 30_000L
    /** The longest one request on [path] may take. */
    fun maximum(path: String): Long = when (path) {
        "/v1/photos" -> PHOTO_MAX_MILLIS
        "/v1/app-update/chunk" -> CHUNK_MAX_MILLIS
        else -> MAX_MILLIS
    }
    fun remaining(requested: Long, deadline: Long, now: Long, path: String = ""): Long {
        require(requested > 0 && deadline >= 0 && now >= 0)
        return minOf(maximum(path), requested, deadline-now).also { check(it > 0) { "Request deadline passed before transport" } }
    }
}
