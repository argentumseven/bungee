package org.bungee.app

import java.util.UUID

/** Expired or delayed starts must not leave an unrecoverable pending approval. */
class CameraStartApproval {
    private var pending: Pair<String, Long>? = null
    @Synchronized fun issue(now: Long): String? {
        if (pending?.let { now >= it.second && now - it.second <= 5000 } == true) return null
        return UUID.randomUUID().toString().also { pending = it to now }
    }
    @Synchronized fun consume(token: String?, now: Long): Boolean {
        val saved = pending ?: return false
        if (token != saved.first) return false // An older intent cannot consume a newer approval.
        pending = null
        return now >= saved.second && now - saved.second <= 5000
    }
    @Synchronized fun cancel() { pending = null }
}
