package org.bungee.app

import org.json.JSONObject
import org.json.JSONArray
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Photo bytes never go to preferences/files. A process exit drops unsent images. */
object PendingPhotos {
    private var state = PhotoOutbox.empty("")
    private val queueCounts = MutableStateFlow(0 to 0L)
    val counts = queueCounts.asStateFlow()
    private fun publishCounts() { queueCounts.value = state.getJSONArray("records").length() to state.optLong("dropped") }
    fun session(): String? = synchronized(PhotoOutbox.lock) {
        state.getString("session").takeIf { it.isNotEmpty() && state.getJSONArray("records").length() > 0 }
    }
    fun resume(session: String) = synchronized(PhotoOutbox.lock) { state.put("session", session); Unit }
    fun append(photo: JSONObject, session: String) = synchronized(PhotoOutbox.lock) {
        check(state.getString("session") == session)
        PhotoOutbox.append(state, photo); publishCounts()
    }
    fun first(session: String): JSONObject? = synchronized(PhotoOutbox.lock) {
        if (state.getString("session") != session) null else state.getJSONArray("records").optJSONObject(0)?.let { JSONObject(it.toString()) }
    }
    fun report(session: String? = null): Pair<Int, Long> = synchronized(PhotoOutbox.lock) {
        if (session != null && state.getString("session") != session) 0 to 0L
        else state.getJSONArray("records").length() to state.optLong("dropped")
    }
    fun metadata(): JSONArray = synchronized(PhotoOutbox.lock) {
        val records=state.getJSONArray("records")
        JSONArray().apply { for (i in 0 until records.length()) {
            val photo=records.getJSONObject(i)
            put(JSONObject().put("id",photo.getString("id")).put("captured_at",photo.getLong("captured_at")).put("reason",photo.getString("reason")))
        } }
    }
    fun acknowledge(id: String, session: String) = synchronized(PhotoOutbox.lock) {
        check(state.getString("session") == session)
        state = PhotoOutbox.acknowledge(state, id)
        publishCounts()
    }
    fun clear() = synchronized(PhotoOutbox.lock) { state = PhotoOutbox.empty(""); publishCounts() }
}
