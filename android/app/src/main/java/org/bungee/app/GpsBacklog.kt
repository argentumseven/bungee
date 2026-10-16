package org.bungee.app

import org.json.JSONArray
import org.json.JSONObject

/** Validation and legacy queue helpers. New persistence uses GpsJournal's incremental records. */
object GpsBacklog {
    const val MAX_POINTS = 10080
    fun append(queue: JSONArray, point: JSONObject): JSONArray {
        val time = point.getLong("observed_at")
        if ((0 until queue.length()).any { queue.getJSONObject(it).getLong("observed_at") == time }) return queue
        return JSONArray().apply {
            for (i in (queue.length() - MAX_POINTS + 1).coerceAtLeast(0) until queue.length()) put(queue.getJSONObject(i))
            put(point)
        }
    }
    fun usable(point: JSONObject, before: Long = Long.MAX_VALUE): Boolean = runCatching {
        val lat = point.getDouble("latitude"); val lon = point.getDouble("longitude"); val accuracy = point.getDouble("accuracy")
        lat.isFinite() && lon.isFinite() && accuracy.isFinite() && lat in -90.0..90.0 && lon in -180.0..180.0 && accuracy in 0.0..100000.0 && point.getLong("observed_at") in 1..before
    }.getOrDefault(false)
    fun batch(queue: JSONArray, limit: Int = 100, before: Long = Long.MAX_VALUE): JSONArray = JSONArray().apply {
        require(limit in 1..100)
        for (i in 0 until queue.length()) {
            val point = queue.getJSONObject(i)
            if (length() < limit && usable(point, before)) put(point)
        }
    }
    fun acknowledge(queue: JSONArray, sent: JSONArray): JSONArray {
        val times = (0 until sent.length()).map { sent.getJSONObject(it).getLong("observed_at") }.toSet()
        return JSONArray().apply {
            for (i in 0 until queue.length()) if (queue.getJSONObject(i).getLong("observed_at") !in times) put(queue.getJSONObject(i))
        }
    }
}
