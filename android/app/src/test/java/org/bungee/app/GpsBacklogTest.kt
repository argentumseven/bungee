package org.bungee.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class GpsBacklogTest {
    private fun point(time: Long) = JSONObject().put("observed_at", time).put("latitude", 37.78).put("longitude", -122.42).put("accuracy", 12)
    @Test fun observationsSurviveSerializationAndDuplicateSamplesDoNotGrowTheQueue() {
        val queued = GpsBacklog.append(JSONArray(), point(1000))
        val restarted = JSONArray(queued.toString())
        assertEquals(1, GpsBacklog.append(restarted, point(1000)).length())
        assertEquals(1000L, GpsBacklog.batch(restarted).getJSONObject(0).getLong("observed_at"))
    }
    @Test fun onlyAcknowledgedPointsAreRemovedAndNewlyQueuedPointsSurvive() {
        var queue = JSONArray()
        for (time in 1L..120L) queue = GpsBacklog.append(queue, point(time))
        val sent = GpsBacklog.batch(queue)
        assertEquals(100, sent.length())
        queue = GpsBacklog.append(queue, point(121))
        // A failed upload does not acknowledge anything; serializing it preserves all 121 fixes.
        assertEquals(121, JSONArray(queue.toString()).length())
        val remaining = GpsBacklog.acknowledge(queue, sent)
        assertEquals(21, remaining.length())
        assertEquals(101L, remaining.getJSONObject(0).getLong("observed_at"))
        assertEquals(21, GpsBacklog.acknowledge(remaining, sent).length())
    }
    @Test fun boundedQueueDropsTheOldestUnsentPointAndKeepsTheNewest() {
        val full = JSONArray()
        for (time in 1L..GpsBacklog.MAX_POINTS.toLong()) full.put(point(time))
        val rolled = GpsBacklog.append(full, point(GpsBacklog.MAX_POINTS.toLong() + 1))
        assertEquals(GpsBacklog.MAX_POINTS, rolled.length())
        assertEquals(2L, rolled.getJSONObject(0).getLong("observed_at"))
        assertEquals(GpsBacklog.MAX_POINTS.toLong() + 1, rolled.getJSONObject(rolled.length() - 1).getLong("observed_at"))
    }
    @Test fun limitedBatchesSkipFutureOrMalformedPointsWithoutDroppingThem() {
        val queue=JSONArray().put(point(5000)).put(point(100)).put(point(101)).put(point(102)).put(point(103).put("accuracy",-1))
        val batch=GpsBacklog.batch(queue,2,1000)
        assertEquals(2,batch.length()); assertEquals(100L,batch.getJSONObject(0).getLong("observed_at"))
        val remaining=GpsBacklog.acknowledge(queue,batch)
        assertEquals(3,remaining.length()); assertEquals(5000L,remaining.getJSONObject(0).getLong("observed_at"))
        assertEquals(2,GpsBacklog.batch(remaining,100,6000).length())
    }
}
