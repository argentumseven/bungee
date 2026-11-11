package org.bungee.app

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

enum class SharingReason(val kind: String, val category: String, val label: String) {
    USER_START("started", "manual", "Started manually in Bungee"),
    AUTOMATIC_START("started", "automatic", "Started through approved automatic recovery"),
    SYSTEM_RESTART("started", "system", "Android restarted the sharing service"),
    USER_STOP("stopped", "manual", "Stopped manually in Bungee"),
    NOTIFICATION_STOP("stopped", "manual", "Stopped using the sharing notification"),
    LOCAL_RECOVERY("stopped", "manual", "Stopped through local recovery"),
    GPS_ON("gps_enabled", "manual", "Automatic GPS sharing enabled manually"),
    GPS_OFF("gps_disabled", "manual", "Automatic GPS sharing disabled manually"),
    CONSENT_STORAGE_ERROR("stopped", "error", "Stopped after a consent/settings storage error"),
    START_RESTRICTED("error", "error", "Android refused to start the sharing service"),
    MANAGEMENT_BLOCKED("stopped", "error", "Stopped because Android management blocked operation"),
    PAIRING_UNAVAILABLE("stopped", "error", "Stopped because pairing was unavailable"),
    WORKER_ERROR("stopped", "error", "Stopped after an unexpected sharing-service error"),
    SERVICE_ENDED("stopped", "unknown", "Sharing service ended; Android supplied no reason"),
    CRASH("stopped", "crash", "Android reported an app crash"),
    NATIVE_CRASH("stopped", "crash", "Android reported a native app crash"),
    ANR("stopped", "error", "Android reported that the app stopped responding"),
    LOW_MEMORY("stopped", "system", "Android stopped the app because memory was low"),
    ANDROID_USER_STOPPED("stopped", "manual", "Android reported a user-requested app stop"),
    PERMISSION_CHANGE("stopped", "system", "Android ended the app after a permission change"),
    PACKAGE_CHANGED("stopped", "system", "Android ended the app during a package change"),
    SYSTEM_KILLED("stopped", "system", "Android ended the app process"),
    ANDROID_EXIT_UNKNOWN("stopped", "unknown", "Android reported a process exit with an unknown cause"),
    LOCATE_START("locate_started", "manual", "Temporary GPS requested through recovery commands"),
    LOCATE_FINISHED("locate_finished", "automatic", "Temporary GPS request completed"),
    LOCATE_ERROR("error", "error", "Temporary GPS request failed or was canceled"),
    UNEXPECTED_EXIT("stopped", "unknown", "Previous sharing session ended; cause and stop time unknown");

    val code get() = name.lowercase()
}

data class SharingEvent(val id: String, val reason: SharingReason, val at: Long?, val recordedAt: Long, val pending: Boolean = true) {
    fun json(local: Boolean = false) = JSONObject().put("id", id).put("reason", reason.code)
        .put("at", at ?: JSONObject.NULL).put("recorded_at", recordedAt).apply { if (local) put("pending", pending) }
    companion object {
        fun create(reason: SharingReason, recordedAt: Long, at: Long? = recordedAt) = SharingEvent(UUID.randomUUID().toString(), reason, at, recordedAt)
        fun parse(value: JSONObject): SharingEvent {
            val event = SharingEvent(value.getString("id"), SharingReason.valueOf(value.getString("reason").uppercase()),
                if (value.isNull("at")) null else value.getLong("at"), value.getLong("recorded_at"), value.optBoolean("pending", true))
            require(UUID.fromString(event.id).toString() == event.id && event.recordedAt > 0 && (event.at == null || event.at > 0))
            require(event.at != null || event.reason == SharingReason.UNEXPECTED_EXIT)
            return event
        }
    }
}

/** Retain recent local history and retry unacknowledged events; never block a stop to make room. */
object SharingEventJournal {
    const val CAPACITY = 128
    const val BATCH = 20
    fun events(state: JSONObject): List<SharingEvent> = state.optJSONArray("events")?.let { rows ->
        require(rows.length() <= CAPACITY)
        (0 until rows.length()).map { SharingEvent.parse(rows.getJSONObject(it)) }
    } ?: emptyList()
    fun append(state: JSONObject, event: SharingEvent): JSONObject {
        val rows = events(state).toMutableList()
        if (rows.any { it.id == event.id }) return state
        rows.add(event)
        if (rows.size > CAPACITY) {
            if (rows.removeAt(0).pending) state.put("dropped", (state.optLong("dropped") + 1).coerceAtMost(9_007_199_254_740_991L))
        }
        return replace(state, rows)
    }
    fun pending(state: JSONObject, before: Long = Long.MAX_VALUE) = JSONArray(events(state).filter { it.pending && it.recordedAt <= before && (it.at == null || it.at <= before) }.take(BATCH).map { it.json() })
    fun acknowledge(state: JSONObject, ids: Set<String>) = replace(state, events(state).map { if (it.id in ids) it.copy(pending = false) else it })
    fun reconcileEpoch(state: JSONObject, epoch: String): JSONObject {
        require(epoch.matches(Regex("[A-Za-z0-9_-]{43}|[a-f0-9]{64}")))
        if (state.has("epoch") && state.getString("epoch") != epoch) {
            replace(state, events(state).map { it.copy(pending = false) })
            state.put("dropped", 0)
        }
        return state.put("epoch", epoch)
    }
    private fun replace(state: JSONObject, events: List<SharingEvent>) = state.put("events", JSONArray(events.map { it.json(local = true) }))
}
