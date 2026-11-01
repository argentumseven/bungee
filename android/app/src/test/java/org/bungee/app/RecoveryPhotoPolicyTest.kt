package org.bungee.app

import org.junit.Assert.*
import org.junit.Test

class RecoveryPhotoPolicyTest {
    @Test fun choosesTheLargestUsefulBoundedSensorSizeInsteadOfTheSmallestThumbnail() {
        assertEquals(2048 to 1536,RecoveryPhotoPolicy.captureSize(listOf(320 to 240,1280 to 960,2048 to 1536,4000 to 3000)))
        assertNull(RecoveryPhotoPolicy.captureSize(listOf(8000 to 6000)))
    }
    @Test fun largeSensorsAreSubsampledBeforeAllocatingABitmap() {
        assertEquals(2,RecoveryPhotoPolicy.decodeSample(3264,2448))
        assertEquals(1,RecoveryPhotoPolicy.decodeSample(2100,1000))
        assertEquals(1,RecoveryPhotoPolicy.decodeSample(2048,1536))
        assertThrows(IllegalArgumentException::class.java){RecoveryPhotoPolicy.decodeSample(8000,6000)}
    }
    @Test fun largePicturesStillHaveAFixedQueueByteBudget() {
        val queue=PhotoOutbox.empty("session")
        repeat(100){index->
            val photo=org.json.JSONObject().put("id",java.util.UUID.randomUUID().toString()).put("captured_at",index+1L)
                .put("reason","local_test").put("failed_attempts",0).put("jpeg","A".repeat(RecoveryPhotoPolicy.MAX_BASE64_CHARS))
            PhotoOutbox.append(queue,photo)
        }
        assertEquals(8,queue.getJSONArray("records").length())
        assertEquals(92,queue.getInt("dropped"))
        val encoded=(0 until 8).sumOf{queue.getJSONArray("records").getJSONObject(it).getString("jpeg").length.toLong()}
        assertTrue(encoded<=8L*RecoveryPhotoPolicy.MAX_BASE64_CHARS)
    }
    @Test fun legacyCheckpointUpgradeDoesNotInventNewFailureEvents() {
        val state=org.json.JSONObject().put("baseline",0).put("previous",5).put("fired",true).put("attempts",org.json.JSONArray().put(0))
        val restored=FailedUnlockGate.restore(state,30_000)
        assertFalse(restored.failed(5,30_000));assertFalse(restored.failed(7,30_001));assertTrue(restored.failed(8,30_002))
    }
}
