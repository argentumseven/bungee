package org.bungee.app

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class ArmedCameraPolicyTest {
    @Test fun threeFailuresDuringATestCooldownRemainEligibleWithoutAFourthFailure() {
        val gate=FailedUnlockGate()
        assertTrue(gate.test(0))
        assertFalse(gate.failed(1,1000));assertFalse(gate.failed(2,2000));assertFalse(gate.failed(3,3000))
        assertEquals(3,gate.progress)
        assertFalse(gate.failed(3,29_999))
        assertTrue(gate.failed(3,30_000))
        assertFalse(gate.failed(3,90_000))
    }
    @Test fun duplicateAndroidCallbacksCannotTriggerDuplicatePhotos() {
        val gate=FailedUnlockGate()
        assertFalse(gate.failed(1,1000));assertFalse(gate.failed(1,1001))
        assertFalse(gate.failed(2,2000));assertFalse(gate.failed(2,2001))
        assertTrue(gate.failed(3,3000));assertFalse(gate.failed(3,3001))
    }
    @Test fun eachAdditionalGroupOfThreeCanTriggerAnotherCaptureAfterCooldown() {
        val gate = FailedUnlockGate();gate.reset(4)
        assertFalse(gate.failed(6,0));assertTrue(gate.failed(7,0))
        assertFalse(gate.failed(10,29_999));assertTrue(gate.failed(11,30_000))
        assertFalse(gate.failed(13,60_000));assertTrue(gate.failed(14,60_001))
        assertFalse(gate.failed(14,120_000)) // No new entries cannot retrigger.
    }
    @Test fun successfulUnlockStartsANewStreakWithoutRemovingThrottle() {
        val gate = FailedUnlockGate();assertTrue(gate.failed(3,0));gate.reset()
        assertFalse(gate.failed(3,29_999));assertTrue(gate.failed(4,30_000))
        gate.reset();assertFalse(gate.failed(2,60_000));assertTrue(gate.failed(3,60_001))
    }
    @Test fun lowerOsCountResetsStreakAndInvalidCountsDoNothing() {
        val gate = FailedUnlockGate(); gate.reset(9)
        assertFalse(gate.failed(-1, 0)); assertFalse(gate.failed(12, -1))
        assertFalse(gate.failed(1, 0)); assertFalse(gate.failed(2, 0)); assertTrue(gate.failed(3, 0))
    }
    @Test fun hourlyBudgetIncludesLocalTestsAndRollsForward() {
        val gate=FailedUnlockGate()
        repeat(20){assertTrue(gate.test(it*30_000L))}
        gate.reset();assertFalse(gate.failed(3,600_000))
        assertFalse(gate.test(3_599_999));assertTrue(gate.test(3_600_000))
    }
    @Test fun rearmingCannotReuseAnOldStreakInANewGate() {
        val old = FailedUnlockGate(); assertTrue(old.failed(3, 0))
        val new = FailedUnlockGate(); new.reset(3)
        assertFalse(new.failed(3, 500_000)); assertTrue(new.failed(6, 500_000))
    }
    private fun photo(id: String = UUID.randomUUID().toString(), reason: String = "failed_unlock", attempts: Int = 3) =
        JSONObject().put("id", id).put("captured_at", 100).put("failed_attempts", attempts).put("reason", reason).put("jpeg", "dGVzdA==")
    @Test fun boundedOutboxRetainsNewestAndAcknowledgesOnlyExactId() {
        val queue=PhotoOutbox.empty("local-session")
        val photos=(0..PhotoOutbox.CAPACITY).map{photo()}
        photos.forEach{PhotoOutbox.append(queue,it)}
        assertEquals(PhotoOutbox.CAPACITY,queue.getJSONArray("records").length());assertEquals(1,queue.getLong("dropped"))
        assertEquals(photos[1].getString("id"),queue.getJSONArray("records").getJSONObject(0).getString("id"))
        PhotoOutbox.acknowledge(queue,photos[0].getString("id"));assertEquals(PhotoOutbox.CAPACITY,queue.getJSONArray("records").length())
        PhotoOutbox.acknowledge(queue,photos[2].getString("id"));assertEquals(PhotoOutbox.CAPACITY-1,queue.getJSONArray("records").length())
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
        gate.failed(8,0); assertEquals(0,gate.progress)
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
        val invalid=PhotoOutbox.empty("old").put("records",org.json.JSONArray().put(photo().put("jpeg","x".repeat(RecoveryPhotoPolicy.MAX_BASE64_CHARS+1))))
        assertThrows(IllegalArgumentException::class.java){PendingPhotos.adoptLegacy(invalid)}
        assertEquals(captured.toString(),PendingPhotos.first("live")!!.toString()); PendingPhotos.clear()
    }
    @Test fun outboxRejectsOversizeAndMislabelledTests() {
        assertThrows(IllegalArgumentException::class.java) { PhotoOutbox.append(PhotoOutbox.empty("s"), photo().put("jpeg", "x".repeat(RecoveryPhotoPolicy.MAX_BASE64_CHARS+1))) }
        assertThrows(IllegalArgumentException::class.java) { PhotoOutbox.append(PhotoOutbox.empty("s"), photo(attempts = 2)) }
        assertThrows(IllegalArgumentException::class.java) { PhotoOutbox.append(PhotoOutbox.empty("s"), photo(reason = "local_test", attempts = 3)) }
        assertEquals(1, PhotoOutbox.append(PhotoOutbox.empty("s"), photo(reason = "local_test", attempts = 0)).getJSONArray("records").length())
    }
    @Test fun manualPicturesHaveNoFailedEntriesAndSurviveTheUploadQueue() {
        val picture = photo(reason = "remote_manual", attempts = 0)
        PendingPhotos.clear(); PendingPhotos.resume("armed")
        PendingPhotos.append(picture, "armed")
        assertEquals("remote_manual", PendingPhotos.metadata().getJSONObject(0).getString("reason"))
        assertEquals(picture.toString(), PendingPhotos.first("armed")!!.toString())
        PendingPhotos.acknowledge(picture.getString("id"), "armed")
        assertNull(PendingPhotos.first("armed"))
        assertThrows(IllegalArgumentException::class.java) { PhotoOutbox.append(PhotoOutbox.empty("s"), photo(reason = "remote_manual", attempts = 3)) }
        assertThrows(IllegalArgumentException::class.java) { PhotoOutbox.append(PhotoOutbox.empty("s"), photo(reason = "unknown", attempts = 0)) }
        PendingPhotos.clear()
    }
    @Test fun remotePicturesAllowEitherLockStateWithoutChangingAutomaticOrTestRules() {
        assertTrue(RecoveryPhotoTrigger.REMOTE_MANUAL.manual)
        assertTrue(RecoveryPhotoTrigger.REMOTE_MANUAL.allowsCapture(true))
        assertTrue(RecoveryPhotoTrigger.REMOTE_MANUAL.allowsCapture(false))
        assertTrue(RecoveryPhotoTrigger.LOCAL_TEST.allowsCapture(false))
        assertFalse(RecoveryPhotoTrigger.LOCAL_TEST.allowsCapture(true))
        assertTrue(RecoveryPhotoTrigger.FAILED_UNLOCK.allowsCapture(true))
        assertFalse(RecoveryPhotoTrigger.FAILED_UNLOCK.allowsCapture(false))
        assertFalse(RecoveryPhotoTrigger.FAILED_UNLOCK.manual)
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
