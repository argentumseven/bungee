package org.bungee.app

import org.json.JSONArray
import org.json.JSONObject

/** Small encrypted-at-rest queue; the enclosing Identity stores this as one encrypted record. */
object PhotoOutbox {
    const val MAX_BYTES = 12 * 1024
    const val CAPACITY = 3
    val lock = Any()
    fun empty(session: String) = JSONObject().put("session", session).put("records", JSONArray()).put("dropped", 0)
    fun append(state: JSONObject, photo: JSONObject): JSONObject {
        require(photo.getString("id").matches(Regex("[a-f0-9-]{36}")))
        require(photo.getLong("captured_at") > 0)
        require((photo.getString("reason") == "failed_unlock" && photo.getInt("failed_attempts") >= 3) || (photo.getString("reason") == "local_test" && photo.getInt("failed_attempts") == 0))
        require(photo.getString("jpeg").length <= MAX_BYTES * 4 / 3)
        val records = state.getJSONArray("records")
        records.put(photo)
        if (records.length() > CAPACITY) {
            records.remove(0)
            state.put("dropped", (state.optLong("dropped") + 1).coerceAtMost(9_007_199_254_740_991))
        }
        return state
    }
    fun acknowledge(state: JSONObject, id: String): JSONObject {
        val old = state.getJSONArray("records")
        state.put("records", JSONArray().apply { for (i in 0 until old.length()) if (old.getJSONObject(i).getString("id") != id) put(old.getJSONObject(i)) })
        return state
    }
}
