package org.bungee.app

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class ArmedCameraPolicyTest {
    @Test fun onlyThreeNewFailuresTriggerOncePerStreak() {
        val gate = FailedUnlockGate()
        gate.reset(4)
        assertFalse(gate.failed(4, 0)); assertFalse(gate.failed(5, 0)); assertFalse(gate.failed(6, 0))
        assertTrue(gate.failed(7, 0)); assertFalse(gate.failed(7, 1)); assertFalse(gate.failed(8, 2))
    }
    @Test fun successfulUnlockStartsANewStreakWithoutRemovingThrottle() {
        val gate = FailedUnlockGate()
        assertTrue(gate.failed(3, 0))
        gate.reset()
        assertFalse(gate.failed(3, 299_999))
        assertFalse(gate.failed(4, 300_000)) // Suppressed attempt still consumes this streak.
        gate.reset(); assertTrue(gate.failed(3, 300_000))
    }
    @Test fun lowerOsCountResetsStreakAndInvalidCountsDoNothing() {
        val gate = FailedUnlockGate(); gate.reset(9)
        assertFalse(gate.failed(-1, 0)); assertFalse(gate.failed(12, -1))
        assertFalse(gate.failed(1, 0)); assertFalse(gate.failed(2, 0)); assertTrue(gate.failed(3, 0))
    }
    @Test fun hourlyBudgetIncludesLocalTestsAndRollsForward() {
        val gate = FailedUnlockGate()
        for (i in 0..5) assertTrue(gate.test(i * 300_000L))
        gate.reset(); assertFalse(gate.failed(3, 1_800_000))
        assertFalse(gate.test(3_599_999)); assertTrue(gate.test(3_600_000))
    }
    @Test fun rearmingCannotReuseAnOldStreakInANewGate() {
        val old = FailedUnlockGate(); assertTrue(old.failed(3, 0))
        val new = FailedUnlockGate(); new.reset(3)
        assertFalse(new.failed(3, 500_000)); assertTrue(new.failed(6, 500_000))
    }
    private fun photo(id: String = UUID.randomUUID().toString(), reason: String = "failed_unlock", attempts: Int = 3) =
        JSONObject().put("id", id).put("captured_at", 100).put("failed_attempts", attempts).put("reason", reason).put("jpeg", "dGVzdA==")
    @Test fun boundedOutboxRetainsNewestAndAcknowledgesOnlyExactId() {
        val queue = PhotoOutbox.empty("local-session")
        val photos = (0..3).map { photo() }
        for (p in photos) PhotoOutbox.append(queue, p)
        assertEquals(3, queue.getJSONArray("records").length()); assertEquals(1, queue.getLong("dropped"))
        assertEquals(photos[1].getString("id"), queue.getJSONArray("records").getJSONObject(0).getString("id"))
        PhotoOutbox.acknowledge(queue, photos[0].getString("id")); assertEquals(3, queue.getJSONArray("records").length())
        PhotoOutbox.acknowledge(queue, photos[2].getString("id")); assertEquals(2, queue.getJSONArray("records").length())
        assertEquals("local-session", queue.getString("session"))
    }
    @Test fun memoryQueueSurvivesCameraSessionRestartButClearAndAckRemoveBytes() {
        PendingPhotos.clear(); PendingPhotos.resume("before")
        val captured = photo(); PendingPhotos.append(captured, "before")
        val metadata=PendingPhotos.metadata().getJSONObject(0)
        assertEquals(captured.getString("id"),metadata.getString("id")); assertFalse(metadata.has("jpeg"))
        PendingPhotos.resume("after")
        assertEquals("after", PendingPhotos.session())
        assertNull(PendingPhotos.first("before"))
        assertEquals(captured.toString(), PendingPhotos.first("after")!!.toString())
        PendingPhotos.acknowledge(captured.getString("id"), "after")
        assertNull(PendingPhotos.session()); assertEquals(0,PendingPhotos.report().first); assertEquals(0,PendingPhotos.counts.value.first)
        PendingPhotos.append(photo(), "after"); PendingPhotos.clear()
        assertNull(PendingPhotos.session()); assertEquals(0,PendingPhotos.report().first); assertEquals(0,PendingPhotos.counts.value.first)
    }
    @Test fun progressCountsOnlyNewFailuresAndResetsOnSuccessfulUnlock() {
        val gate = FailedUnlockGate(); gate.reset(5)
        gate.failed(7,0); assertEquals(2,gate.progress)
        gate.failed(8,0); assertEquals(3,gate.progress)
        gate.failed(0,1); assertEquals(0,gate.progress)
    }
    @Test fun legacyPhotoMigrationPreservesPicturesAndDoesNotDuplicateThemOnRetry() {
        PendingPhotos.clear()
        val captured=photo(); val legacy=PhotoOutbox.append(PhotoOutbox.empty("old-session"),captured)
        PendingPhotos.adoptLegacy(legacy); PendingPhotos.adoptLegacy(legacy)
        assertEquals(1,PendingPhotos.report().first)
        PendingPhotos.resume("new-session")
        assertEquals(captured.toString(),PendingPhotos.first("new-session")!!.toString())
        PendingPhotos.acknowledge(captured.getString("id"),"new-session")
        assertNull(PendingPhotos.session()); PendingPhotos.clear()
    }
    @Test fun invalidLegacyPhotoCannotPartiallyReplaceTheMemoryQueue() {
        PendingPhotos.clear(); PendingPhotos.resume("live")
        val captured=photo(); PendingPhotos.append(captured,"live")
        val invalid=PhotoOutbox.empty("old").put("records",org.json.JSONArray().put(photo().put("jpeg","x".repeat(16_385))))
        assertThrows(IllegalArgumentException::class.java){PendingPhotos.adoptLegacy(invalid)}
        assertEquals(captured.toString(),PendingPhotos.first("live")!!.toString()); PendingPhotos.clear()
    }
    @Test fun outboxRejectsOversizeAndMislabelledTests() {
        assertThrows(IllegalArgumentException::class.java) { PhotoOutbox.append(PhotoOutbox.empty("s"), photo().put("jpeg", "x".repeat(16_385))) }
        assertThrows(IllegalArgumentException::class.java) { PhotoOutbox.append(PhotoOutbox.empty("s"), photo(attempts = 2)) }
        assertThrows(IllegalArgumentException::class.java) { PhotoOutbox.append(PhotoOutbox.empty("s"), photo(reason = "local_test", attempts = 3)) }
        assertEquals(1, PhotoOutbox.append(PhotoOutbox.empty("s"), photo(reason = "local_test", attempts = 0)).getJSONArray("records").length())
    }
    @Test fun withdrawalVetoesBothCaptureCommitAndPreparedUploadEvenAfterRearm() {
        val fence = DisclosureFence(); var armed = true; var canceled = 0
        val stamp = fence.stamp(); val ticket = fence.reserve(stamp, { armed }, { canceled++ })
        fence.change { armed = false }; fence.change { armed = true }
        assertEquals(1, canceled)
        assertThrows(IllegalStateException::class.java) { fence.checked(stamp, { armed }) { error("An old capture must not commit") } }
        assertThrows(IllegalStateException::class.java) { DisclosureRequest(fence, { 1 }, {}).exchange(stamp, { armed }, { 100 }) { _, _ -> error("Old photo must not be sent") } }
        fence.release(ticket)
    }
}
