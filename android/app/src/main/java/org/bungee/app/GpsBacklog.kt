package org.bungee.app

import org.json.JSONArray
import org.json.JSONObject

/** Pure queue operations; Identity encrypts the serialized result before persistence. */
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
    fun batch(queue: JSONArray): JSONArray = JSONArray().apply {
        for (i in 0 until queue.length().coerceAtMost(100)) put(queue.getJSONObject(i))
    }
    fun acknowledge(queue: JSONArray, sent: JSONArray): JSONArray {
        val times = (0 until sent.length()).map { sent.getJSONObject(it).getLong("observed_at") }.toSet()
        return JSONArray().apply {
            for (i in 0 until queue.length()) if (queue.getJSONObject(i).getLong("observed_at") !in times) put(queue.getJSONObject(i))
        }
    }
}
